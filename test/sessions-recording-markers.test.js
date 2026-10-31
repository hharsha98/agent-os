// Task U11, spec SP4 "SP4 done when": "fake agents produce the recording markers". The real session manager, the real
// hooks router (Task X2a) and sessions router on a real port, the real recorder, mirror and changes poll (Task X7), in
// a temp git repository, with W1's TUI-like fake `claude` in a real PTY. Its `hook` command posts Claude's
// UserPromptSubmit and PermissionRequest events to the session's own hook address, and the test edits a tracked file
// and posts PostToolUse (which asks for a changes read at once). The markers route and the recording route then give
// the replay what it shows (src/ui/replayShared.ts reads both here, as the page does), and Delete recording takes the
// moments with the files. No real agent starts: the test builds the profile itself (the fake's path, the fake bin plus
// the system folders on PATH, the stand-in login shell), with the two hook variables Task X2a's sessionEnv adds for a
// Claude Code agent session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createHooksRouter } from "../server/runtime/sessions/hooks.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";
import { buildTimeline, parseCast } from "../src/ui/replayShared.ts";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const isWindows = process.platform === "win32";
// Node's own folder is left out on purpose: it can hold real agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const CLAUDE_UUID = "0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";
const SECRET_PROMPT = "a prompt only the agent may see 7f3a";

async function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

// The pids this test started and has not seen exit (the system may give an exited pid to another process).
function track(running, handle) {
  running.add(handle.pid);
  handle.onExit(() => {
    running.delete(handle.pid);
  });
  return handle;
}

function killLeftovers(running) {
  for (const pid of [...running]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    running.delete(pid);
  }
}

test(
  "fake agents produce the recording markers: a prompt (label only), a permission asked with its text and the files changed with +/−; the replay reads them on the recording's own clock; Delete recording takes them with it",
  { skip: isWindows ? "the fake agents are POSIX shell shims" : false },
  async () => {
    // Real paths: on macOS os.tmpdir() sits behind a symlink, and the folder policy compares real paths.
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-markers-home-")));
    const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-markers-data-")));
    const bin = path.join(home, "fake-bin");
    const folder = path.join(home, "projects", "replay-app");
    const running = new Set();
    let server = null;
    let manager = null;
    let id = null;
    try {
      await mkdir(folder, { recursive: true });
      await mkdir(bin, { recursive: true });
      await makeFakeAgentBin(bin); // all six names, mode tui
      // A real git repository with one tracked file (real git runs only inside temp folders).
      const git = (...args) =>
        execFileSync(
          "git",
          ["-C", folder, "-c", "user.name=Agent OS test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
          { env: { PATH: SYSTEM_PATH_DIRS.join(path.delimiter), HOME: home, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] }
        );
      git("init", "-q");
      await writeFile(path.join(folder, "notes.md"), "one\n");
      git("add", "notes.md");
      git("commit", "-q", "-m", "start");

      await withEnv(
        {
          HOME: home,
          USERPROFILE: home,
          AGENT_OS_HOME: agentOsHome,
          AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
          HERMES_AGENT_OS_HOME: undefined,
          HERMES_HOME: undefined,
          HERMES_AGENT_OS_ENABLE_EXEC: undefined,
          AGENT_OS_PACKAGED: undefined,
          SHELL: FAKE_LOGIN_SHELL,
          PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter)
        },
        async () => {
          assert.equal(os.homedir(), home, "tests must never see the real home folder");
          const app = express();
          server = await new Promise((resolve) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
          });
          const port = server.address().port;
          const profileInputs = [];
          manager = createSessionManager({
            isExecutionAllowed: async () => true,
            detect: async () => ({ installed: true, path: path.join(bin, "claude") }),
            resolveBrain: async () => null,
            getPort: () => port,
            buildProfile: async (input) => {
              profileInputs.push(input);
              return {
                command: path.join(bin, "claude"),
                args: ["--session-id", CLAUDE_UUID],
                cwd: input.folder,
                env: {
                  PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
                  HOME: home,
                  USERPROFILE: home,
                  SHELL: FAKE_LOGIN_SHELL,
                  TERM: "xterm-256color",
                  LANG: "en_US.UTF-8",
                  ...(input.hook
                    ? {
                        AGENT_OS_HOOK_URL: `http://127.0.0.1:${input.hook.port}/hooks/sessions/${input.sessionId}`,
                        AGENT_OS_HOOK_TOKEN: input.hook.token
                      }
                    : {})
                },
                agentSessionId: CLAUDE_UUID,
                settingsFile: null,
                softStop: "claude-bg",
                resumeMode: "id",
                folderShown: true,
                notes: [],
                claude: null
              };
            },
            spawn: async (options) => track(running, await spawnPty(options))
          });
          // As server/index.js mounts them: the hooks router before any JSON parser.
          app.use("/hooks", createHooksRouter({ manager, isLocal: () => true }));
          app.use(express.json());
          app.use("/api/sessions", createSessionsRouter({ manager }));
          const http = async (method, url) => {
            const response = await fetch(`http://127.0.0.1:${port}${url}`, { method });
            const text = await response.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            return { status: response.status, text, json };
          };

          ({ id } = await manager.create({ agentId: "claude", folder }));
          assert.equal(profileInputs[0].hook?.port, port, "the manager gives a Claude Code agent session its hook address (Task X2a)");
          const frames = [];
          await manager.attach(id, { id: "w", send: (frame) => frames.push(frame), close() {} });
          assert.equal(manager.focus(id, "w"), true);
          const screen = () =>
            frames
              .filter((frame) => frame.t === "out")
              .map((frame) => frame.d)
              .join("");
          const answered = () => (screen().match(/HOOK 204/g) || []).length;
          const type = (line) => assert.equal(manager.write(id, "w", `${line}\r`), true);
          await waitFor(() => screen().includes("FAKE_ARGV"));
          // The first changes read is the baseline: it never makes a marker (K12).
          await waitFor(async () => (await manager.changes(id)).at !== null, { timeoutMs: 15000 });

          type(`hook UserPromptSubmit ${JSON.stringify({ prompt: SECRET_PROMPT })}`);
          await waitFor(() => answered() === 1);
          await waitFor(async () => (await manager.markers(id)).length === 1);
          type(`hook PermissionRequest ${JSON.stringify({ tool_name: "Bash" })}`);
          await waitFor(() => answered() === 2);
          await waitFor(async () => (await manager.markers(id)).length === 2);
          // E1 test gap: the list the badge, the Home strip and the tabs read carries the alert and the alert mode
          // (spec, Alerts UI), and so does the session's own address.
          for (const url of ["/api/sessions", `/api/sessions/${id}`]) {
            const answer = await http("GET", url);
            assert.equal(answer.status, 200, answer.text);
            const item = url === "/api/sessions" ? answer.json.sessions.find((session) => session.id === id) : answer.json;
            assert.equal(item.status, "waiting", url);
            assert.deepEqual([item.alert.kind, item.alert.text], ["waiting", "Wants to use Bash"], url);
            assert.equal(new Date(item.alert.at).toISOString(), item.alert.at, `${url}: the time the alert began`);
            assert.equal(item.alerts, "full", `${url}: Claude's hooks spoke, so alerts are full`);
          }
          await writeFile(path.join(folder, "notes.md"), "one\ntwo\nthree\n");
          type(`hook PostToolUse ${JSON.stringify({ tool_name: "Edit" })}`);
          await waitFor(async () => (await manager.markers(id)).length === 3, { timeoutMs: 15000 });
          type("exit 0");
          await waitFor(async () => !manager.isLive(id));
          const metaFile = path.join(agentOsHome, "sessions", id, "meta.json");
          await waitFor(async () => JSON.parse(await readFile(metaFile, "utf8")).status === "exited");
          const meta = JSON.parse(await readFile(metaFile, "utf8"));

          const markers = await http("GET", `/api/sessions/${id}/markers`);
          assert.equal(markers.status, 200, markers.text);
          assert.deepEqual(markers.json.markers.map((marker) => marker.type), ["prompt", "permission", "files"]);
          assert.deepEqual(Object.keys(markers.json.markers[0]).sort(), ["at", "type"], "a prompt marker is label only (R23)");
          assert.equal(markers.json.markers[1].text, "Wants to use Bash");
          assert.deepEqual(markers.json.markers[2].files, [{ path: "notes.md", added: 2, removed: 0 }]);
          assert.equal(markers.json.markers[2].more, 0);
          assert.deepEqual(meta.markers, markers.json.markers, "an ended session's markers are read from meta.json");
          assert.equal(JSON.stringify(meta).includes(SECRET_PROMPT), false, "the prompt's text is stored nowhere in meta.json");

          const recording = await http("GET", `/api/sessions/${id}/recording`);
          assert.equal(recording.status, 200);
          const cast = parseCast(recording.text);
          assert.ok(cast, "the recording reads as an asciicast");
          const timeline = buildTimeline(cast, markers.json, { endAt: meta.endedAt });
          assert.deepEqual(timeline.moments.map((moment) => moment.label), ["Prompt", "Permission asked: Wants to use Bash", "Files changed: 1"]);
          assert.deepEqual(timeline.moments.map((moment) => moment.detail), ["", "Wants to use Bash", "notes.md (+2 −0)"]);
          for (const moment of timeline.moments) {
            assert.ok(moment.t >= 0 && moment.t <= timeline.wallSeconds, `${moment.label} at ${moment.t} s lies on the timeline (0 to ${timeline.wallSeconds} s)`);
          }
          assert.ok(timeline.moments[0].t <= timeline.moments[1].t && timeline.moments[1].t <= timeline.moments[2].t, "in the order they happened");
          // The permission moment sits where the fake's answer to that hook is in the recording (header times are whole seconds).
          const hookAnswers = cast.events.filter((event) => event[1] === "o" && event[2].includes("HOOK 204")).map((event) => event[0]);
          assert.ok(hookAnswers.length >= 2, "both answers are in the recording");
          assert.ok(Math.abs(timeline.moments[1].t - hookAnswers[1]) < 2, `permission moment ${timeline.moments[1].t} s, answer on screen ${hookAnswers[1]} s`);
          assert.equal(timeline.segments[0].from, 0);
          assert.equal(timeline.segments.at(-1).to, timeline.wallSeconds);
          for (let i = 1; i < timeline.segments.length; i += 1) assert.equal(timeline.segments[i].from, timeline.segments[i - 1].to, "the segments cover the whole length");

          const deleted = await http("DELETE", `/api/sessions/${id}/recording`);
          assert.equal(deleted.status, 200, deleted.text);
          assert.deepEqual(deleted.json, { ok: true });
          assert.deepEqual((await http("GET", `/api/sessions/${id}/markers`)).json, { markers: [] }, "the moments went with the recording");
          const gone = await http("GET", `/api/sessions/${id}/recording`);
          assert.equal(gone.status, 404);
          assert.equal(gone.json.error, "recording_missing");
          assert.equal((await manager.get(id)).resume.available, true, "the session and its Resume stay");
        }
      );
    } finally {
      killLeftovers(running);
      if (manager && id) await waitFor(async () => !manager.isLive(id), { timeoutMs: 5000 }).catch(() => {});
      if (server) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(home, { recursive: true, force: true });
      await rm(agentOsHome, { recursive: true, force: true });
    }
  }
);
