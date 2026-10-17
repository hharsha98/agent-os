import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listWorkspaceFiles, resolveWorkspaceFile, writeWorkspaceText } from "../server/runtime/workspace.js";
import { setExecutionGateStatus } from "../server/runtime/execution-gate.js";
import { applyFileProposal, undoAction } from "../server/runtime/team-room/actions.js";
import { createRoom, roomShort, updateDecision } from "../server/runtime/team-room/room-store.js";

async function withTempRuntime(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-workspace-"));
  const previous = process.env.HERMES_AGENT_OS_HOME;
  process.env.HERMES_AGENT_OS_HOME = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.HERMES_AGENT_OS_HOME;
    else process.env.HERMES_AGENT_OS_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("workspace listing seeds a one-time welcome note inside the sandbox", async () => {
  await withTempRuntime(async (root) => {
    const listing = await listWorkspaceFiles();
    const workspaceRoot = listing.roots.find((item) => item.id === "workspace");
    assert.equal(listing.files.length, 1);
    assert.equal(listing.empty, false);
    assert.equal(listing.files[0].id, "workspace/inbox/welcome.md");
    assert.ok(workspaceRoot);
    assert.match(workspaceRoot.publicPath, /workspace$/);
    const marker = path.join(root, "config", "workspace-welcome-seeded.json");
    await fs.access(marker);
    await fs.rm(path.join(root, "workspace", "inbox", "welcome.md"));
    const again = await listWorkspaceFiles();
    assert.equal(again.files.length, 0);
    assert.equal(again.empty, true);
  });
});

test("workspace listing includes a file written to the sandbox", async () => {
  await withTempRuntime(async (root) => {
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "workspace-welcome-seeded.json"), "{\"seeded\":true}\n");
    const filePath = path.join(root, "workspace", "hello.txt");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "hello");
    const listing = await listWorkspaceFiles();
    assert.equal(listing.files.length, 1);
    assert.equal(listing.files[0].name, "hello.txt");
    assert.equal(listing.files[0].id, "workspace/hello.txt");
    assert.ok(!listing.files[0].publicPath.includes(os.homedir()));
  });
});

test("workspace file ids reject path travel", async () => {
  await withTempRuntime(async () => {
    await assert.rejects(() => resolveWorkspaceFile("../etc/passwd"), /file must be inside workspace or exports|file path is not allowed|outside/i);
    await assert.rejects(() => resolveWorkspaceFile("workspace/../../etc/passwd"), /file must be inside workspace or exports|file path is not allowed|outside/i);
  });
});

test("workspace write saves markdown inside the sandbox and rejects path travel", async () => {
  await withTempRuntime(async () => {
    const saved = await writeWorkspaceText({
      folder: "loop",
      name: "2026-08-16.md",
      content: "# morning briefing\n"
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.file.id, "workspace/loop/2026-08-16.md");
    assert.match(saved.previewText, /morning briefing/);
    const listing = await listWorkspaceFiles({ query: "2026-08-16" });
    assert.equal(listing.files[0].id, "workspace/loop/2026-08-16.md");
    await assert.rejects(
      () => writeWorkspaceText({ relativePath: "../secret.md", content: "nope" }),
      /not allowed|outside|inside/i
    );
    await assert.rejects(
      () => writeWorkspaceText({ name: "run.sh", content: "echo hi" }),
      /only \.md/i
    );
  });
});

// ---------------------------------------------------------------------------
// "Saved by": who saved each file (SP2, Workspace)
// ---------------------------------------------------------------------------

const UNKNOWN = { kind: "unknown", label: "—" };
const ROOM_LIMITS = { maxTurns: 6, maxMinutes: 10, maxCostUsd: null };
const GATE_ENV_NAMES = ["HERMES_AGENT_OS_ENABLE_EXEC", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE"];

// withTempRuntime plus: AGENT_OS_HOME pinned to the temp folder (it outranks
// HERMES_AGENT_OS_HOME, so a shell that exports it cannot send these tests to a
// real data folder), no environment override of the execution gate, no demo
// mode, and the gate switched on, so a Team Room save really writes its file.
async function withPinnedRuntime(fn) {
  await withTempRuntime(async (root) => {
    const names = ["AGENT_OS_HOME", ...GATE_ENV_NAMES];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.AGENT_OS_HOME = root;
    for (const name of GATE_ENV_NAMES) delete process.env[name];
    try {
      await setExecutionGateStatus({ enabled: true, reason: "workspace test" });
      await fn(root);
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });
}

function newRoom() {
  return createRoom({ task: "who saved this file", limits: ROOM_LIMITS });
}

// What Approve does in the Team Room: a file proposal that waits for the
// person, then the real applyFileProposal. Returns the action record.
async function saveInRoom(roomId, { name, content, by = "hermes", byLabel = "Hermes" }) {
  const proposalId = await updateDecision(roomId, (decision) => {
    const id = `P${decision.proposals.length + 1}`;
    decision.proposals.push({
      id,
      by,
      byLabel,
      kind: "file",
      summary: `Save ${name}`,
      file: { name, content },
      status: "needs_approval",
      turn: 1,
      createdAt: new Date().toISOString()
    });
    return id;
  });
  return applyFileProposal(roomId, proposalId);
}

const teamFileId = (roomId, name) => `workspace/team/${roomShort(roomId)}/${name}`;
const teamFilePath = (root, roomId, name) => path.join(root, "workspace", "team", roomShort(roomId), name);

async function savedByOf(id, input = {}) {
  const listing = await listWorkspaceFiles(input);
  return listing.files.find((file) => file.id === id)?.savedBy;
}

test("savedBy: the welcome note reads Agent OS and a file dropped in by hand reads —", async () => {
  await withPinnedRuntime(async (root) => {
    await listWorkspaceFiles(); // seeds the welcome note
    await fs.writeFile(path.join(root, "workspace", "dropped.txt"), "by hand");
    const listing = await listWorkspaceFiles();
    const by = Object.fromEntries(listing.files.map((file) => [file.id, file.savedBy]));
    assert.deepEqual(by["workspace/inbox/welcome.md"], { kind: "agent-os", label: "Agent OS" });
    assert.deepEqual(by["workspace/dropped.txt"], UNKNOWN);
    assert.equal(listing.summary.savedByAgents, 0);
  });
});

test("savedBy: the demo files read Agent OS in demo mode", async () => {
  await withPinnedRuntime(async () => {
    const listing = await listWorkspaceFiles({ demoPublic: true });
    const demo = listing.files.filter((file) => file.relativePath.startsWith("demo/") || file.relativePath === "notes/start-here.md");
    assert.ok(demo.length >= 3, "the demo files are listed");
    for (const file of demo) assert.deepEqual(file.savedBy, { kind: "agent-os", label: "Agent OS" }, file.id);
  });
});

test("savedBy: a note the person saves reads You, and Agent OS writing over it does not", async () => {
  await withPinnedRuntime(async () => {
    await writeWorkspaceText({ folder: "loop", name: "mine.md", content: "# mine" }, { savedBy: "you" });
    await writeWorkspaceText({ folder: "loop", name: "ours.md", content: "# written by Agent OS itself" });
    const mine = await savedByOf("workspace/loop/mine.md");
    assert.equal(mine.kind, "you");
    assert.equal(mine.label, "You");
    assert.ok(Number.isFinite(Date.parse(mine.at)), "it says when");
    assert.deepEqual(await savedByOf("workspace/loop/ours.md"), UNKNOWN, "a write with no savedBy is never the person's");

    // Agent OS's own writers (live chat, briefings) pass no savedBy: once one of
    // them rewrites the file, the content is no longer the person's.
    await writeWorkspaceText({ folder: "loop", name: "mine.md", content: "# rewritten by Agent OS" });
    assert.deepEqual(await savedByOf("workspace/loop/mine.md"), UNKNOWN);
  });
});

test("savedBy: a damaged provenance file never breaks the listing, and the next save repairs it", async () => {
  await withPinnedRuntime(async (root) => {
    await writeWorkspaceText({ folder: "loop", name: "mine.md", content: "# mine" }, { savedBy: "you" });
    const record = path.join(root, "config", "workspace-provenance.json");
    for (const damage of ["{ not json", "", "null", "[]", JSON.stringify({ files: "nope" })]) {
      await fs.writeFile(record, damage);
      assert.deepEqual(await savedByOf("workspace/loop/mine.md"), UNKNOWN, `damage: ${damage || "(empty)"}`);
    }
    await writeWorkspaceText({ folder: "loop", name: "again.md", content: "# again" }, { savedBy: "you" });
    assert.equal((await savedByOf("workspace/loop/again.md")).kind, "you");
  });
});

test("savedBy: a Team Room save reads the agent's name, with the room and the action to undo", async () => {
  await withPinnedRuntime(async () => {
    const room = await newRoom();
    const action = await saveInRoom(room.id, { name: "plan.md", content: "# plan" });
    const listing = await listWorkspaceFiles();
    const file = listing.files.find((item) => item.id === teamFileId(room.id, "plan.md"));
    assert.deepEqual(file.savedBy, {
      kind: "team-room",
      label: "Hermes",
      at: action.at,
      roomId: room.id,
      actionId: "A1"
    });
    assert.equal(listing.summary.savedByAgents, 1);
    assert.equal(listing.summary.total, 2, "the welcome note and the saved file");
  });
});

test("savedBy: the latest save wins, and Undo hands the file back to the earlier save", async () => {
  await withPinnedRuntime(async (root) => {
    const room = await newRoom();
    const id = teamFileId(room.id, "plan.md");
    await saveInRoom(room.id, { name: "plan.md", content: "v1", by: "hermes", byLabel: "Hermes" });
    await saveInRoom(room.id, { name: "plan.md", content: "v2", by: "openclaw", byLabel: "OpenClaw" });
    let by = await savedByOf(id);
    assert.deepEqual([by.kind, by.label, by.actionId], ["team-room", "OpenClaw", "A2"]);

    // The person clicks Undo a minute later, not a moment later: the saves in the
    // log are now a minute old, but the copy Undo puts back is brand new.
    const logPath = path.join(root, "teams", room.id, "decision.json");
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));
    for (const action of log.actions) action.at = new Date(Date.parse(action.at) - 60_000).toISOString();
    await fs.writeFile(logPath, JSON.stringify(log));

    await undoAction(room.id, "A2");
    assert.equal(await fs.readFile(teamFilePath(root, room.id, "plan.md"), "utf8"), "v1", "Undo put the first save back");
    by = await savedByOf(id);
    assert.deepEqual([by.kind, by.label, by.actionId], ["team-room", "Hermes", "A1"], "the copy Undo restored is not an outside edit");

    await undoAction(room.id, "A1");
    const listing = await listWorkspaceFiles();
    assert.equal(listing.files.some((file) => file.id === id), false, "a file the room created is gone after Undo");
    assert.equal(listing.summary.savedByAgents, 0);
  });
});

test("savedBy: after Undo puts back a file that was there before the room, nobody is named", async () => {
  await withPinnedRuntime(async (root) => {
    const room = await newRoom();
    const id = teamFileId(room.id, "plan.md");
    const file = teamFilePath(root, room.id, "plan.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "what was already here");
    assert.deepEqual(await savedByOf(id), UNKNOWN);

    await saveInRoom(room.id, { name: "plan.md", content: "agent version" });
    assert.equal((await savedByOf(id)).kind, "team-room");
    await undoAction(room.id, "A1");
    assert.equal(await fs.readFile(file, "utf8"), "what was already here");
    assert.deepEqual(await savedByOf(id), UNKNOWN);
  });
});

test("savedBy: a deleted room, a missing log or a damaged log reads —, never a crash", async () => {
  await withPinnedRuntime(async (root) => {
    const damages = {
      "the room folder was deleted": (roomDir) => fs.rm(roomDir, { recursive: true, force: true }),
      "decision.json is missing": (roomDir) => fs.rm(path.join(roomDir, "decision.json"), { force: true }),
      "decision.json is empty": (roomDir) => fs.writeFile(path.join(roomDir, "decision.json"), ""),
      "decision.json is not JSON": (roomDir) => fs.writeFile(path.join(roomDir, "decision.json"), "{ not json"),
      "decision.json holds the wrong shapes": (roomDir) =>
        fs.writeFile(
          path.join(roomDir, "decision.json"),
          JSON.stringify({ proposals: "none", actions: [null, 7, "A1", { id: "A1" }, { id: "A1", kind: "file_write" }] })
        )
    };
    for (const [what, damage] of Object.entries(damages)) {
      const room = await newRoom();
      const id = teamFileId(room.id, "notes.md");
      await saveInRoom(room.id, { name: "notes.md", content: "# notes" });
      assert.equal((await savedByOf(id)).kind, "team-room", `${what}: named before the damage`);
      await damage(path.join(root, "teams", room.id));
      assert.deepEqual(await savedByOf(id), UNKNOWN, what);
    }
  });
});

test("savedBy: a record for another room's folder, a refused save and a bad action id are ignored", async () => {
  await withPinnedRuntime(async (root) => {
    const roomA = await newRoom();
    const roomB = await newRoom();
    await saveInRoom(roomA.id, { name: "a.md", content: "# a" });
    const folderA = path.join(root, "workspace", "team", roomShort(roomA.id));
    const folderB = path.join(root, "workspace", "team", roomShort(roomB.id));
    await fs.mkdir(folderB, { recursive: true });
    for (const name of ["c.md", "d.md"]) await fs.writeFile(path.join(folderA, name), "# by hand");
    await fs.writeFile(path.join(folderB, "b.md"), "# by hand");

    // Room A's log is edited so that it claims room B's file, holds a save that
    // was refused, and holds an action id that is not an action id.
    const logPath = path.join(root, "teams", roomA.id, "decision.json");
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));
    const base = { kind: "file_write", proposalId: "P1", created: true, updated: false, backup: null, at: new Date().toISOString(), undone: false, undoneAt: null };
    log.actions.push(
      { ...base, id: "A2", path: `team/${roomShort(roomB.id)}/b.md` },
      { ...base, id: "A3", path: `team/${roomShort(roomA.id)}/c.md`, failed: true },
      { ...base, id: "../../etc", path: `team/${roomShort(roomA.id)}/d.md` }
    );
    await fs.writeFile(logPath, JSON.stringify(log));

    const listing = await listWorkspaceFiles();
    const by = Object.fromEntries(listing.files.map((file) => [file.id, file.savedBy]));
    assert.equal(by[teamFileId(roomA.id, "a.md")].kind, "team-room", "the real save is still named");
    assert.deepEqual(by[teamFileId(roomB.id, "b.md")], UNKNOWN, "room A cannot claim room B's file");
    assert.deepEqual(by[teamFileId(roomA.id, "c.md")], UNKNOWN, "a refused save wrote nothing");
    assert.deepEqual(by[teamFileId(roomA.id, "d.md")], UNKNOWN, "an action id that is not A<number> is never passed on");
  });
});

test("savedBy: the agent name is short plain text even if the log was edited", async () => {
  await withPinnedRuntime(async (root) => {
    const room = await newRoom();
    await saveInRoom(room.id, { name: "plan.md", content: "# plan" });
    const logPath = path.join(root, "teams", room.id, "decision.json");
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));
    log.proposals[0].byLabel = `Hermes\n\u0007${"x".repeat(200)}`;
    await fs.writeFile(logPath, JSON.stringify(log));
    const by = await savedByOf(teamFileId(room.id, "plan.md"));
    assert.equal(by.kind, "team-room");
    assert.ok(by.label.length <= 60, `label is ${by.label.length} characters`);
    assert.doesNotMatch(by.label, /[\u0000-\u001f\u007f]/);
    assert.match(by.label, /^Hermes/);

    log.proposals[0].byLabel = "";
    delete log.proposals[0].by;
    await fs.writeFile(logPath, JSON.stringify(log));
    assert.equal((await savedByOf(teamFileId(room.id, "plan.md"))).label, "An agent", "no name on record: say so plainly");
  });
});

test("savedBy: a file changed after an agent saved it reads Changed outside Agent OS and has nothing to undo", async () => {
  await withPinnedRuntime(async (root) => {
    const room = await newRoom();
    const id = teamFileId(room.id, "plan.md");
    const file = teamFilePath(root, room.id, "plan.md");
    await saveInRoom(room.id, { name: "plan.md", content: "agent v1" });
    assert.equal((await savedByOf(id)).kind, "team-room");

    // The person edits it in their own editor a little later.
    await fs.writeFile(file, "my own edit");
    const later = new Date(Date.now() + 10_000);
    await fs.utimes(file, later, later);
    const edited = await savedByOf(id);
    assert.equal(edited.kind, "unknown", "Agent OS cannot tell who changed it, so it does not guess");
    assert.equal(edited.label, "Changed outside Agent OS");
    assert.equal(edited.roomId, undefined, "no room and no action, so the page has no Undo to offer");
    assert.equal(edited.actionId, undefined);
    assert.equal((await listWorkspaceFiles()).summary.savedByAgents, 0);

    // The agent saves a newer version after the person approves it again: the file is the agent's again.
    await saveInRoom(room.id, { name: "plan.md", content: "agent v2", by: "openclaw", byLabel: "OpenClaw" });
    const again = await savedByOf(id);
    assert.deepEqual([again.kind, again.label, again.actionId], ["team-room", "OpenClaw", "A2"]);
  });
});

// ---------------------------------------------------------------------------
// "Saved by", fix round 1: a record is trusted only while the file is still the
// one that was saved
// ---------------------------------------------------------------------------

const CHANGED_OUTSIDE = { kind: "unknown", label: "Changed outside Agent OS" };

function assertChangedOutside(by, what) {
  assert.deepEqual({ kind: by.kind, label: by.label }, CHANGED_OUTSIDE, what);
  assert.ok(Number.isFinite(Date.parse(by.at)), `${what}: it says when the file was last changed`);
  assert.equal(by.roomId, undefined, `${what}: no room, so no Undo to offer`);
  assert.equal(by.actionId, undefined, `${what}: no action, so no Undo to offer`);
}

test("savedBy: a note you saved stops reading You once the file is changed or replaced on disk", async () => {
  await withPinnedRuntime(async (root) => {
    const id = "workspace/loop/mine.md";
    const file = path.join(root, "workspace", "loop", "mine.md");
    const stampIn = async (seconds) => {
      const when = new Date(Date.now() + seconds * 1000);
      await fs.utimes(file, when, when);
    };

    await writeWorkspaceText({ folder: "loop", name: "mine.md", content: "# mine" }, { savedBy: "you" });
    assert.equal((await savedByOf(id)).kind, "you");

    // An agent run, or an editor, overwrites it a minute later. The record of
    // the person's save is still on file; the file is no longer that save.
    await fs.writeFile(file, "# an agent run wrote this");
    await stampIn(60);
    assertChangedOutside(await savedByOf(id), "overwritten after the save");

    // Deleted in Finder, and a different file with the same name dropped in.
    await fs.rm(file);
    await fs.writeFile(file, "# dropped in by hand");
    await stampIn(120);
    assertChangedOutside(await savedByOf(id), "replaced after the save");

    // Saving it again through the app makes it the person's note again.
    await writeWorkspaceText({ folder: "loop", name: "mine.md", content: "# mine again" }, { savedBy: "you" });
    assert.equal((await savedByOf(id)).kind, "you");

    // A record with no usable time cannot be checked against the file, so it is not trusted.
    await fs.writeFile(path.join(root, "config", "workspace-provenance.json"), JSON.stringify({ version: 1, files: { [id]: { kind: "you" } } }));
    assert.deepEqual(await savedByOf(id), UNKNOWN);
  });
});

test("savedBy: after Undo puts back a person's edit, the earlier agent save is not named", async () => {
  await withPinnedRuntime(async (root) => {
    const room = await newRoom();
    const id = teamFileId(room.id, "plan.md");
    const file = teamFilePath(root, room.id, "plan.md");
    await saveInRoom(room.id, { name: "plan.md", content: "agent v1" });

    // The person edits it by hand. The agent then saves over the edit (the room
    // keeps the edit as its backup), and the person clicks Undo on that second save.
    await fs.writeFile(file, "my own edit");
    const later = new Date(Date.now() + 10_000);
    await fs.utimes(file, later, later);
    await saveInRoom(room.id, { name: "plan.md", content: "agent v2" });
    await undoAction(room.id, "A2");
    assert.equal(await fs.readFile(file, "utf8"), "my own edit", "Undo put the person's edit back");

    // The file's time now looks like Agent OS's own doing, but the text is not A1's.
    assertChangedOutside(await savedByOf(id), "the earlier save is not the file's content");
    assert.equal((await listWorkspaceFiles()).summary.savedByAgents, 0);
    await assert.rejects(
      undoAction(room.id, "A1"),
      (error) => error.code === "changed_since_save",
      "the page would not have been offered an Undo the server refuses"
    );
  });
});

test("savedBy: a Team Room file that does not hold the save's text is not named, whatever its modified time says", async () => {
  await withPinnedRuntime(async (root) => {
    const room = await newRoom();
    const id = teamFileId(room.id, "plan.md");
    const file = teamFilePath(root, room.id, "plan.md");
    const logPath = path.join(root, "teams", room.id, "decision.json");
    const action = await saveInRoom(room.id, { name: "plan.md", content: "agent v1" });
    const atSaveTime = async () => {
      const when = new Date(action.at);
      await fs.utimes(file, when, when);
    };

    // An edit a moment after the save: inside the clock slack, but not the agent's text.
    await fs.writeFile(file, "quick edit");
    assertChangedOutside(await savedByOf(id), "an edit right after the save");

    // A copy that keeps its old date (cp -p, a restore, a sync tool).
    await fs.writeFile(file, "restored copy");
    const earlier = new Date(Date.now() - 3_600_000);
    await fs.utimes(file, earlier, earlier);
    assertChangedOutside(await savedByOf(id), "different text with an old modified time");

    // The agent's own text back in place is the agent's save again.
    await fs.writeFile(file, "agent v1");
    await atSaveTime();
    assert.deepEqual((await savedByOf(id)).actionId, "A1");

    // A save recorded before the fingerprint existed is judged by the proposal's
    // text, the way Undo judges it.
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));
    delete log.actions[0].contentSha256;
    await fs.writeFile(logPath, JSON.stringify(log));
    assert.equal((await savedByOf(id)).actionId, "A1", "same text as the proposal: still the agent's");
    await fs.writeFile(file, "something else");
    await atSaveTime();
    assertChangedOutside(await savedByOf(id), "different text from the proposal");
  });
});

test("savedBy: a save with neither a fingerprint nor the proposal's text is not offered for Undo, and is not called 'changed' either", async () => {
  await withPinnedRuntime(async (root) => {
    const room = await newRoom();
    const id = teamFileId(room.id, "plan.md");
    const file = teamFilePath(root, room.id, "plan.md");
    const logPath = path.join(root, "teams", room.id, "decision.json");
    const action = await saveInRoom(room.id, { name: "plan.md", content: "agent v1" });
    const atSaveTime = async () => {
      const when = new Date(action.at);
      await fs.utimes(file, when, when);
    };
    assert.equal((await savedByOf(id)).actionId, "A1", "with its fingerprint, the agent's save is offered");

    // Strip both the fingerprint and the proposal's text: nothing to compare against.
    await updateDecision(room.id, (decision) => {
      delete decision.actions[0].contentSha256;
      delete decision.proposals[0].file.content;
    });
    assert.equal(JSON.parse(await fs.readFile(logPath, "utf8")).actions[0].contentSha256, undefined);
    await atSaveTime();
    // The file still holds the agent's text, but Undo would refuse, so it is not offered. The label is true:
    // it does not claim a change that may never have happened.
    const unchecked = await savedByOf(id);
    assert.equal(unchecked.kind, "unknown", "no Undo is offered");
    assert.equal(unchecked.label, "Team Room (can't check for later changes)");
    assert.notEqual(unchecked.label, "Changed outside Agent OS", "nothing says the file changed");
    assert.ok(unchecked.label.length <= 60, "short enough for the page, which keeps the first 60 characters");
    assert.equal(unchecked.roomId, undefined, "no room, so no Undo to offer");
    assert.equal(unchecked.actionId, undefined, "no action, so no Undo to offer");
    assert.equal(unchecked.at, action.at, "it says when the save was made");
    assert.equal((await listWorkspaceFiles()).summary.savedByAgents, 0, "it does not count as a file an agent's Undo covers");
    assert.equal(await fs.readFile(file, "utf8"), "agent v1", "listing never touches the file");

    // The same save, but the file was touched long after it: a comparison (the clock) really did show a change.
    await fs.writeFile(file, "my own edit");
    const later = new Date(Date.now() + 10_000);
    await fs.utimes(file, later, later);
    assertChangedOutside(await savedByOf(id), "modified long after the save, even with nothing to compare the text with");
  });
});

test("workspace listing names the real folder of each root, so the desktop app can reveal it", async () => {
  await withTempRuntime(async (root) => {
    const listing = await listWorkspaceFiles({ demoPublic: false });
    const byId = Object.fromEntries(listing.roots.map((item) => [item.id, item]));
    assert.equal(byId.workspace.absolutePath, path.join(root, "workspace"));
    assert.equal(byId.exports.absolutePath, path.join(root, "exports"));
    assert.ok(path.isAbsolute(byId.workspace.absolutePath));
    // The display text is unchanged: it is never the real home folder.
    assert.equal(byId.workspace.publicPath, "~/.hermes-agent-os/workspace");
  });
});

test("workspace listing on the public demo never reveals the real folder", async () => {
  await withTempRuntime(async () => {
    const listing = await listWorkspaceFiles({ demoPublic: true });
    for (const item of listing.roots) assert.equal(item.absolutePath, null, item.id);
  });
});
