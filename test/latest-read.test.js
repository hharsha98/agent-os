// The top bar's safety pill reads the gate every 5 s, and each read may wait up to 10 s. The guard in
// src/ui/latestRead.ts keeps a slow, old answer from landing over a newer one: one read at a time,
// and only the newest read may update the screen. The file has no imports, so Node loads it straight
// from src/. The reads here are fakes that the test answers by hand; nothing talks to a server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLatestRead } from "../src/ui/latestRead.ts";

// A read the test answers itself, when it chooses.
function manual() {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a read's answer is applied, and a failed read is applied as a failure", async () => {
  const reads = createLatestRead();
  const seen = [];
  assert.equal(await reads.run(async () => "level 1", (outcome) => seen.push(outcome)), true);
  assert.equal(await reads.run(() => Promise.reject(new Error("down")), (outcome) => seen.push(outcome)), true);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { ok: true, value: "level 1" });
  assert.equal(seen[1].ok, false);
  assert.equal(seen[1].error.message, "down");
});

test("one read at a time: a poll that arrives while a read is still waiting does not start another", async () => {
  const reads = createLatestRead();
  const slow = manual();
  let started = 0;
  const applied = [];
  const first = reads.run(() => {
    started += 1;
    return slow.promise;
  }, (outcome) => applied.push(outcome.value));
  // The next two polls come while the first read has no answer yet.
  assert.equal(await reads.run(() => { started += 1; return Promise.resolve("newer"); }, (outcome) => applied.push(outcome.value)), false);
  assert.equal(await reads.run(() => { started += 1; return Promise.resolve("newer"); }, (outcome) => applied.push(outcome.value)), false);
  assert.equal(started, 1, "only the first read was made");
  slow.resolve("old");
  assert.equal(await first, true);
  assert.deepEqual(applied, ["old"]);
  // Once it is done, the next poll reads again.
  assert.equal(await reads.run(async () => "next", (outcome) => applied.push(outcome.value)), true);
  assert.deepEqual(applied, ["old", "next"]);
});

test("a read that failed frees the guard, so the next poll is not stuck behind it", async () => {
  const reads = createLatestRead();
  const seen = [];
  await reads.run(() => Promise.reject(new Error("timed out")), (outcome) => seen.push(outcome.ok));
  assert.equal(await reads.run(async () => 1, (outcome) => seen.push(outcome.ok)), true);
  assert.deepEqual(seen, [false, true]);
});

test("newest read wins: a slow old answer that arrives after a newer one is dropped", async () => {
  const reads = createLatestRead();
  const old = manual();
  const applied = [];
  const oldRead = reads.run(() => old.promise, (outcome) => applied.push(outcome.value));
  // Something newer takes over (the screen asked again): the old read no longer counts.
  reads.cancel();
  assert.equal(await reads.run(async () => "new", (outcome) => applied.push(outcome.value)), true, "a new read starts even though the old one has no answer yet");
  assert.deepEqual(applied, ["new"]);
  old.resolve("old");
  await oldRead;
  await flush();
  assert.deepEqual(applied, ["new"], "the old answer did not overwrite the new one");
});

test("an old read that fails late does not overwrite a newer answer either", async () => {
  const reads = createLatestRead();
  const old = manual();
  const applied = [];
  const oldRead = reads.run(() => old.promise, (outcome) => applied.push(outcome.ok ? outcome.value : "failed"));
  reads.cancel();
  await reads.run(async () => "new", (outcome) => applied.push(outcome.ok ? outcome.value : "failed"));
  old.reject(new Error("late"));
  await oldRead;
  assert.deepEqual(applied, ["new"]);
});

test("an old read finishing does not free the guard of the newer read still waiting", async () => {
  const reads = createLatestRead();
  const old = manual();
  const newer = manual();
  const applied = [];
  const oldRead = reads.run(() => old.promise, (outcome) => applied.push(outcome.value));
  reads.cancel();
  const newerRead = reads.run(() => newer.promise, (outcome) => applied.push(outcome.value));
  old.resolve("old");
  await oldRead;
  // The newer read is still waiting, so another poll must not start a third.
  let third = 0;
  assert.equal(await reads.run(() => { third += 1; return Promise.resolve("third"); }, () => {}), false);
  assert.equal(third, 0);
  newer.resolve("new");
  await newerRead;
  assert.deepEqual(applied, ["new"]);
});

test("cancel: a read that was in flight when the screen went away is not applied", async () => {
  const reads = createLatestRead();
  const pending = manual();
  const applied = [];
  const read = reads.run(() => pending.promise, (outcome) => applied.push(outcome.value));
  reads.cancel();
  pending.resolve("too late");
  await read;
  assert.deepEqual(applied, []);
  // Cancelling with nothing in flight is harmless, and reading still works afterwards.
  reads.cancel();
  assert.equal(await reads.run(async () => "fine", (outcome) => applied.push(outcome.value)), true);
  assert.deepEqual(applied, ["fine"]);
});

test("the top bar uses the guard, and keeps one copy of the read", async () => {
  const { readFileSync } = await import("node:fs");
  const shell = readFileSync(new URL("../src/ui/Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /createLatestRead/, "Shell builds the guard");
  assert.match(shell, /reads\.run\(/, "the gate read goes through it");
  assert.match(shell, /reads\.cancel\(\)/, "and the guard is released when the bar goes away");
  assert.equal(shell.match(/getExecutionGateStatus\(\)/g)?.length, 1, "one place reads the gate");
});
