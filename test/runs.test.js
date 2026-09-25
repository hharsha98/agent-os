// The run manager: launching, streaming, stopping, and recovering agent
// runs, plus the read/stream/stop-only HTTP surface in front of it.
import assert from "node:assert/strict";
import express from "express";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunManager } from "../server/runtime/runs/run-manager.js";
import { createRunsRouter } from "../server/runtime/runs/routes.js";

const isWindows = process.platform === "win32";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped", "timed_out", "interrupted"]);

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-runs-home-"));
  const previous = process.env.AGENT_OS_HOME;
  process.env.AGENT_OS_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_HOME;
    else process.env.AGENT_OS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

async function withWorkDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-runs-work-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFake(dir, name, source) {
  const file = path.join(dir, name);
  await writeFile(file, source, "utf8");
  return file;
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

function waitForTerminal(manager, id, timeoutMs = 15000) {
  return waitFor(
    async () => {
      const run = await manager.getRun(id);
      return run && TERMINAL_STATUSES.has(run.status) ? run : null;
    },
    { timeoutMs }
  );
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const SLEEP_FOREVER = "setInterval(function () {}, 1000);\n";

const THREE_LINES = [
  "console.log('line1');",
  "console.log('line2');",
  "console.log('line3');",
  "process.exit(0);"
].join("\n");

const EXIT_TWO = "process.exit(2);\n";

const ECHO_STDIN = [
  "process.stdin.setEncoding('utf8');",
  "var data = '';",
  "process.stdin.on('data', function (chunk) { data += chunk; });",
  "process.stdin.on('end', function () { console.log('got:' + data); process.exit(0); });"
].join("\n");

const PRINT_SECRET = "console.log('key=sk-test-SECRET123456');\n";

const PRINT_10KB = "console.log('x'.repeat(10000));\n";

const JSON_LINES = [
  "console.log(JSON.stringify({ type: 'text', text: 'hi' }));",
  "console.log(JSON.stringify({ type: 'usage', costUsd: 0.01 }));",
  "console.log(JSON.stringify({ type: 'text', text: 'hi' }));",
  "console.log(JSON.stringify({ type: 'usage', costUsd: 0.01 }));"
].join("\n");

function treeFakeSource() {
  return [
    "var fs = require('fs');",
    "var spawn = require('child_process').spawn;",
    "var pidFile = process.argv[2];",
    "console.log('started');",
    // Not detached, so it stays in the fake's process group and dies with it.
    "var grandchild = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000);'], { stdio: 'ignore' });",
    "fs.writeFileSync(pidFile, String(grandchild.pid));",
    "setInterval(function () {}, 1000);"
  ].join("\n");
}

function tickFakeSource(count, delayMs) {
  return [
    "var i = 0;",
    "var timer = setInterval(function () {",
    "  i += 1;",
    "  console.log('tick ' + i);",
    `  if (i >= ${count}) { clearInterval(timer); process.exit(0); }`,
    `}, ${delayMs});`
  ].join("\n");
}

function jsonParseLine(line) {
  try {
    return [JSON.parse(line)];
  } catch {
    return null;
  }
}

test("happy path: 3 lines and a clean exit", async () => {
  await withTempHome(async (home) => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const fake = await writeFake(workDir, "three-lines.cjs", THREE_LINES);
      const started = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "three lines",
        command: process.execPath,
        args: [fake],
        cwd: workDir
      });
      assert.equal(started.status, "running");
      const finished = await waitForTerminal(manager, started.id);
      assert.equal(finished.status, "succeeded");
      assert.equal(finished.exitCode, 0);

      const events = await manager.readEvents(started.id);
      const lineTexts = events.filter((e) => e.type === "line").map((e) => e.text);
      assert.deepEqual(lineTexts, ["line1", "line2", "line3"]);
      assert.ok(events.some((e) => e.type === "system" && e.text.startsWith("Started")));
      assert.ok(events.some((e) => e.type === "system" && e.text === "Exited with code 0"));

      const metaFile = path.join(home, "agent-runs", `${started.id}.json`);
      const eventsFile = path.join(home, "agent-runs", `${started.id}.jsonl`);
      await assert.doesNotReject(() => readFile(metaFile, "utf8"));
      await assert.doesNotReject(() => readFile(eventsFile, "utf8"));
    });
  });
});

test("non-zero exit code becomes failed", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const fake = await writeFake(workDir, "exit-two.cjs", EXIT_TWO);
      const started = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "exit 2",
        command: process.execPath,
        args: [fake],
        cwd: workDir
      });
      const finished = await waitForTerminal(manager, started.id);
      assert.equal(finished.status, "failed");
      assert.equal(finished.exitCode, 2);
    });
  });
});

test("stopRun kills the whole process tree", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const pidFile = path.join(workDir, "grandchild.pid");
      const fake = await writeFake(workDir, "tree.cjs", treeFakeSource());
      const started = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "tree",
        command: process.execPath,
        args: [fake, pidFile],
        cwd: workDir
      });
      assert.equal(started.status, "running");
      await waitFor(async () => {
        try {
          const content = await readFile(pidFile, "utf8");
          return content.trim() ? content : null;
        } catch {
          return null;
        }
      });
      const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
      const stopped = await manager.stopRun(started.id);
      assert.equal(stopped.status, "stopped");
      if (!isWindows) {
        await waitFor(() => (!isAlive(started.pid) && !isAlive(grandchildPid) ? true : null), { timeoutMs: 5000 });
        assert.equal(isAlive(started.pid), false);
        assert.equal(isAlive(grandchildPid), false);
      }
    });
  });
});

test("timeoutMs kills a run that never exits", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const fake = await writeFake(workDir, "sleep.cjs", SLEEP_FOREVER);
      const started = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "sleeper",
        command: process.execPath,
        args: [fake],
        cwd: workDir,
        timeoutMs: 300
      });
      const finished = await waitForTerminal(manager, started.id);
      assert.equal(finished.status, "timed_out");
    });
  });
});

test("stdin is delivered to the child", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const fake = await writeFake(workDir, "echo-stdin.cjs", ECHO_STDIN);
      const started = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "echo",
        command: process.execPath,
        args: [fake],
        cwd: workDir,
        stdin: "hello-stdin"
      });
      const finished = await waitForTerminal(manager, started.id);
      assert.equal(finished.status, "succeeded");
      const events = await manager.readEvents(started.id);
      assert.ok(events.some((e) => e.type === "line" && e.text === "got:hello-stdin"));
    });
  });
});

test("redaction strips secrets from stored output", async () => {
  await withTempHome(async (home) => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const secret = "sk-test-SECRET123456";
      const fake = await writeFake(workDir, "secret.cjs", PRINT_SECRET);
      const started = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "secret",
        command: process.execPath,
        args: [fake],
        cwd: workDir,
        redact: [secret]
      });
      const finished = await waitForTerminal(manager, started.id);
      assert.equal(finished.status, "succeeded");
      const events = await manager.readEvents(started.id);
      const lineEvent = events.find((e) => e.type === "line" && e.text.startsWith("key="));
      assert.ok(lineEvent);
      assert.equal(lineEvent.text, "key=[redacted]");
      assert.ok(!JSON.stringify(events).includes(secret));

      const rawJsonl = await readFile(path.join(home, "agent-runs", `${started.id}.jsonl`), "utf8");
      assert.ok(!rawJsonl.includes(secret));
    });
  });
});

test("output cap truncates and stops storing", async () => {
  await withTempHome(async (home) => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager({ maxOutputBytes: 1000 });
      const fake = await writeFake(workDir, "big.cjs", PRINT_10KB);
      const started = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "big output",
        command: process.execPath,
        args: [fake],
        cwd: workDir
      });
      const finished = await waitForTerminal(manager, started.id);
      assert.equal(finished.truncated, true);
      const rawJsonl = await readFile(path.join(home, "agent-runs", `${started.id}.jsonl`), "utf8");
      // A little slack over the cap for the single notice event itself.
      assert.ok(Buffer.byteLength(rawJsonl) <= 1400, `stored bytes were ${Buffer.byteLength(rawJsonl)}`);
      const events = await manager.readEvents(started.id);
      const notices = events.filter((e) => e.type === "system" && e.text.includes("not stored"));
      assert.equal(notices.length, 1);
    });
  });
});

test("parseLine produces structured events and aggregates usage", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const fake = await writeFake(workDir, "json-lines.cjs", JSON_LINES);
      const started = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "json lines",
        command: process.execPath,
        args: [fake],
        cwd: workDir,
        parseLine: (line) => jsonParseLine(line)
      });
      const finished = await waitForTerminal(manager, started.id);
      assert.equal(finished.status, "succeeded");
      const events = await manager.readEvents(started.id);
      assert.equal(events.filter((e) => e.type === "text" && e.text === "hi").length, 2);
      assert.equal(events.filter((e) => e.type === "usage").length, 2);
      assert.ok(Math.abs(finished.usage.costUsd - 0.02) < 1e-9);
    });
  });
});

test("maxConcurrent rejects a second run", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager({ maxConcurrent: 1 });
      const fake = await writeFake(workDir, "sleep.cjs", SLEEP_FOREVER);
      const first = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "sleeper one",
        command: process.execPath,
        args: [fake],
        cwd: workDir
      });
      await assert.rejects(
        () =>
          manager.startRun({
            agentId: "fake",
            kind: "agent",
            title: "sleeper two",
            command: process.execPath,
            args: [fake],
            cwd: workDir
          }),
        (error) => error.code === "too_many_runs"
      );
      await manager.stopRun(first.id);
    });
  });
});

test("a blocked flag refuses the run before spawning", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const before = await manager.listRuns();
      await assert.rejects(
        () =>
          manager.startRun({
            agentId: "fake",
            kind: "agent",
            title: "blocked",
            command: process.execPath,
            args: ["-e", "0", "--dangerously-skip-permissions"],
            cwd: workDir
          }),
        (error) => error.code === "blocked_flag"
      );
      const after = await manager.listRuns();
      assert.equal(after.length, before.length);
    });
  });
});

test("invalid plans are rejected", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      await assert.rejects(() => manager.startRun({ command: "node", args: [], cwd: workDir }));
      await assert.rejects(() =>
        manager.startRun({ command: process.execPath, args: [], cwd: path.join(workDir, "missing") })
      );
      await assert.rejects(() => manager.startRun({ command: process.execPath, args: [123], cwd: workDir }));
    });
  });
});

test("recoverStaleRuns marks unowned running metadata interrupted", async () => {
  await withTempHome(async (home) => {
    const manager = createRunManager();
    const dir = path.join(home, "agent-runs");
    await mkdir(dir, { recursive: true });
    const id = "run_stale00_deadbeefcafe";
    const meta = {
      id,
      agentId: "fake",
      kind: "agent",
      title: "stale",
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
      pid: 999999999,
      cwd: home,
      commandPreview: "fake",
      truncated: false,
      usage: {},
      error: null
    };
    await writeFile(path.join(dir, `${id}.json`), `${JSON.stringify(meta, null, 2)}\n`);
    await manager.recoverStaleRuns();
    const after = await manager.getRun(id);
    assert.equal(after.status, "interrupted");
  });
});

test("routes: list, events, SSE stream, stop, and validation", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const app = express();
      app.use(express.json());
      app.use("/api/runs", createRunsRouter(manager));

      const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const base = `http://127.0.0.1:${server.address().port}`;

      try {
        const fake = await writeFake(workDir, "ticks.cjs", tickFakeSource(5, 80));
        const started = await manager.startRun({
          agentId: "fake",
          kind: "agent",
          title: "ticks",
          command: process.execPath,
          args: [fake],
          cwd: workDir
        });

        const listRes = await fetch(`${base}/api/runs`);
        assert.equal(listRes.status, 200);
        const listBody = await listRes.json();
        assert.ok(listBody.runs.some((run) => run.id === started.id));

        const eventsRes = await fetch(`${base}/api/runs/${started.id}/events`);
        assert.equal(eventsRes.status, 200);
        const eventsBody = await eventsRes.json();
        assert.ok(Array.isArray(eventsBody.events));

        const streamRes = await fetch(`${base}/api/runs/${started.id}/stream`);
        assert.equal(streamRes.status, 200);
        assert.match(streamRes.headers.get("content-type") || "", /text\/event-stream/);
        const blocks = await collectSse(streamRes, (collected) => collected.some((b) => b.event === "end"));
        const tickLines = blocks.filter((b) => b.event === "line").map((b) => JSON.parse(b.data).text);
        assert.deepEqual(tickLines, ["tick 1", "tick 2", "tick 3", "tick 4", "tick 5"]);
        assert.equal(blocks[blocks.length - 1].event, "end");

        const reconnectRes = await fetch(`${base}/api/runs/${started.id}/stream`, {
          headers: { "Last-Event-ID": "2" }
        });
        const replayed = await collectSse(reconnectRes, (collected) => collected.some((b) => b.event === "end"));
        for (const block of replayed) {
          if (block.event === "end") continue;
          const event = JSON.parse(block.data);
          assert.ok(event.seq > 2, `expected seq > 2, got ${event.seq}`);
        }

        const stopRes = await fetch(`${base}/api/runs/${started.id}/stop`, { method: "POST" });
        assert.equal(stopRes.status, 200);

        const badIdRes = await fetch(`${base}/api/runs/!!/stop`, { method: "POST" });
        assert.equal(badIdRes.status, 400);

        const noStartRes = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "/bin/echo" })
        });
        assert.equal(noStartRes.status, 404);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});

test("stopAll stops every running run", async () => {
  await withTempHome(async () => {
    await withWorkDir(async (workDir) => {
      const manager = createRunManager();
      const fake = await writeFake(workDir, "sleep.cjs", SLEEP_FOREVER);
      const first = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "sleeper one",
        command: process.execPath,
        args: [fake],
        cwd: workDir
      });
      const second = await manager.startRun({
        agentId: "fake",
        kind: "agent",
        title: "sleeper two",
        command: process.execPath,
        args: [fake],
        cwd: workDir
      });
      await manager.stopAll();
      const afterFirst = await manager.getRun(first.id);
      const afterSecond = await manager.getRun(second.id);
      assert.equal(afterFirst.status, "stopped");
      assert.equal(afterSecond.status, "stopped");
    });
  });
});

// Parses a text/event-stream response body into { id, event, data } blocks,
// stopping as soon as `isDone` is satisfied so the test doesn't hang waiting
// for the connection to close on its own.
async function collectSse(response, isDone) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const blocks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const block = { id: null, event: null, data: null };
        for (const line of raw.split("\n")) {
          if (line.startsWith("id:")) block.id = line.slice(3).trim();
          else if (line.startsWith("event:")) block.event = line.slice(6).trim();
          else if (line.startsWith("data:")) block.data = (block.data || "") + line.slice(5).trim();
        }
        if (block.event === null && block.data === null) continue; // ping comment
        blocks.push(block);
        if (isDone(blocks)) return blocks;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return blocks;
}
