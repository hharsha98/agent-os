// A safety claim about a different profile (final review, Sa Important 2). The Agents panels read and change one
// Hermes profile (HERMES_HOME from Agent OS's saved connection) and one OpenClaw profile (the server's own
// environment), while a session keeps the login shell's environment (H1). When the two differ, the panel's "always ask
// before deleting" says nothing about the profile a session really runs in. profile-split.js decides that from the
// cached login-shell read, without waiting for it, and says nothing when the shell could not be read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HERMES_PROFILE_NOTE,
  OPENCLAW_PROFILE_NOTE,
  OPENCLAW_PROFILE_VARIABLES,
  sessionsUseAnotherProfile,
  withProfileSplit
} from "../server/runtime/agents/profile-split.js";
import { getLoginShellEnv, peekLoginShellEnv, resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import { FAKE_LOGIN_SHELL } from "./helpers/fake-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "/Users/someone";
const shell = (env, source = "login-shell") => ({ env, source, notice: null });

test("the notes are the owner's words, word for word", () => {
  assert.equal(HERMES_PROFILE_NOTE, "Sessions use another Hermes profile, and this panel doesn't show its settings.");
  assert.equal(OPENCLAW_PROFILE_NOTE, "Sessions use another OpenClaw profile, and this panel doesn't show its settings.");
});

test("Hermes: the login shell's HERMES_HOME against the saved connection's, as resolved paths", () => {
  const split = (shellHome, panelHome, extra = {}) =>
    sessionsUseAnotherProfile("hermes", { shell: shell(shellHome === undefined ? {} : { HERMES_HOME: shellHome }), panelHermesHome: panelHome, serverEnv: {}, home: HOME, ...extra });
  assert.equal(split(undefined, null), false, "neither says anything: the default profile on both sides");
  assert.equal(split("/data/work", null), true, "the shell names a profile and the panel uses the default");
  assert.equal(split(undefined, "/data/work"), true, "the connection names a profile and the sessions use the default");
  assert.equal(split("/data/work", "/data/work"), false);
  assert.equal(split("/data/work", "/data/other"), true);
  // Compared as resolved paths: ~ is expanded and a trailing slash does not matter.
  assert.equal(split("~/work", `${HOME}/work`), false, "~ expands to the home folder");
  assert.equal(split("~", HOME), false);
  assert.equal(split("/data/work/", "/data/work"), false, "no trailing slash");
  assert.equal(split("/data/./work", "/data/work"), false);
  assert.equal(split("/data/a/../work", "/data/work"), false);
  // Unset is the default folder, so naming it is not a different profile.
  assert.equal(split(`${HOME}/.hermes`, null), false);
  assert.equal(split("~/.hermes/", null), false);
  assert.equal(split("", null), false, "an empty value is unset");
  assert.equal(split("   ", null), false);
  // Only the shell's HERMES_HOME counts, not the server's own environment or other variables.
  assert.equal(split(undefined, null, { serverEnv: { HERMES_HOME: "/data/work" } }), false);
});

test("OpenClaw: any of its state or profile variables that differ between the login shell and the server", () => {
  assert.deepEqual(OPENCLAW_PROFILE_VARIABLES, ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_CONFIG_DIR", "OPENCLAW_HOME"]);
  const split = (shellEnv, serverEnv) => sessionsUseAnotherProfile("openclaw", { shell: shell(shellEnv), panelHermesHome: null, serverEnv, home: HOME });
  assert.equal(split({}, {}), false);
  assert.equal(split({ PATH: "/usr/bin" }, { PATH: "/bin", HERMES_HOME: "/x" }), false, "other variables do not count");
  for (const name of OPENCLAW_PROFILE_VARIABLES) {
    const value = name === "OPENCLAW_PROFILE" ? "work" : "/data/work";
    assert.equal(split({ [name]: value }, {}), true, `${name} set by the shell only`);
    assert.equal(split({}, { [name]: value }), true, `${name} set by the server only`);
    assert.equal(split({ [name]: value }, { [name]: value }), false, `${name} the same on both`);
  }
  assert.equal(split({ OPENCLAW_PROFILE: "work" }, { OPENCLAW_PROFILE: "home" }), true, "two different names");
  assert.equal(split({ OPENCLAW_STATE_DIR: "~/state/" }, { OPENCLAW_STATE_DIR: `${HOME}/state` }), false, "paths are compared resolved");
  assert.equal(split({ OPENCLAW_PROFILE: "" }, {}), false, "an empty value is unset");
});

test("no claim either way when the shell could not be read, or has not been read yet, or for an agent with no profile", () => {
  const args = { panelHermesHome: "/data/other", serverEnv: { OPENCLAW_PROFILE: "x" }, home: HOME };
  assert.equal(sessionsUseAnotherProfile("hermes", { ...args, shell: null }), false, "not read yet");
  assert.equal(sessionsUseAnotherProfile("hermes", { ...args, shell: undefined }), false);
  assert.equal(sessionsUseAnotherProfile("hermes", { ...args, shell: { env: { HERMES_HOME: "/data/work" }, source: "fallback", notice: "x" } }), false, "the fallback environment is not the person's shell");
  assert.equal(sessionsUseAnotherProfile("openclaw", { ...args, shell: { env: { OPENCLAW_PROFILE: "work" }, source: "fallback", notice: "x" } }), false);
  assert.equal(sessionsUseAnotherProfile("hermes", { ...args, shell: { source: "login-shell" } }), false, "no environment in the answer");
  assert.equal(sessionsUseAnotherProfile("hermes", { ...args, shell: { env: "nope", source: "login-shell" } }), false);
  // Windows has no login shell: the process environment is what sessions get, and it is a real answer.
  assert.equal(sessionsUseAnotherProfile("hermes", { ...args, shell: { env: { HERMES_HOME: "/data/work" }, source: "process", notice: null } }), true);
  for (const agentId of ["claude", "codex", "cursor", "other"]) {
    assert.equal(sessionsUseAnotherProfile(agentId, { ...args, shell: shell({ HERMES_HOME: "/data/work", OPENCLAW_PROFILE: "w" }) }), false, agentId);
  }
});

test("withProfileSplit adds the note and the flag to a safety answer only when the profiles differ, and never changes the rest", async () => {
  const safety = { permissive: false, summary: "Hermes approvals are on.", actions: [], known: true, notes: ["a calm fact"], mode: "smart" };
  const deps = (over = {}) => ({
    peekShell: () => shell({ HERMES_HOME: "/data/work" }),
    resolveHermesHome: async () => null,
    serverEnv: {},
    home: HOME,
    ...over
  });
  const split = await withProfileSplit("hermes", safety, deps());
  assert.deepEqual(split, { ...safety, otherProfile: true, notes: ["a calm fact", HERMES_PROFILE_NOTE] });
  assert.deepEqual(safety.notes, ["a calm fact"], "the answer it was given is not changed");
  assert.equal((await withProfileSplit("hermes", { ...safety, notes: undefined }, deps())).notes.at(-1), HERMES_PROFILE_NOTE, "no notes yet");
  // Same profile, shell not read, shell unreadable: the answer comes back as it came.
  assert.equal(await withProfileSplit("hermes", safety, deps({ resolveHermesHome: async () => "/data/work" })), safety);
  assert.equal(await withProfileSplit("hermes", safety, deps({ peekShell: () => null })), safety);
  assert.equal(await withProfileSplit("hermes", safety, deps({ peekShell: () => shell({}, "fallback") })), safety);
  assert.equal(await withProfileSplit("claude", safety, deps()), safety, "an agent with no profile");
  // A reader that throws makes no claim.
  assert.equal(
    await withProfileSplit("hermes", safety, deps({ resolveHermesHome: async () => { throw new Error("no store"); } })),
    safety
  );
  assert.equal(
    await withProfileSplit("hermes", safety, deps({ peekShell: () => { throw new Error("boom"); } })),
    safety
  );
  const open = await withProfileSplit("openclaw", { ...safety, summary: "x" }, deps({ peekShell: () => shell({ OPENCLAW_PROFILE: "work" }) }));
  assert.equal(open.otherProfile, true);
  assert.equal(open.notes.at(-1), OPENCLAW_PROFILE_NOTE);
  // A safety answer that is not an object is passed on.
  assert.equal(await withProfileSplit("hermes", null, deps()), null);
});

test("F1: two names for one folder (a link) are not 'another profile': real paths are compared, the text only for a path that does not exist, and only when the text differs", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-profile-split-")));
  try {
    const target = path.join(dir, "real-hermes");
    const other = path.join(dir, "other-hermes");
    const link = path.join(dir, "link-hermes");
    await mkdir(target);
    await mkdir(other);
    if (process.platform !== "win32") await symlink(target, link, "dir");
    const safety = { permissive: false, summary: "Hermes approvals are on.", actions: [], known: true, notes: [] };
    const deps = (shellHome, panelHome, over = {}) => ({
      peekShell: () => shell(shellHome === undefined ? {} : { HERMES_HOME: shellHome }),
      resolveHermesHome: async () => panelHome,
      serverEnv: {},
      home: dir,
      ...over
    });
    if (process.platform !== "win32") {
      // The shell names the folder, the saved connection names the link to it, and the other way round: one profile.
      assert.equal(await withProfileSplit("hermes", safety, deps(target, link)), safety, "the target and a link to it");
      assert.equal(await withProfileSplit("hermes", safety, deps(link, target)), safety, "a link and its target");
      // The default folder ~/.hermes is a link to the folder the shell names.
      await symlink(target, path.join(dir, ".hermes"), "dir");
      assert.equal(await withProfileSplit("hermes", safety, deps(target, null)), safety, "the default folder is a link to the shell's folder");
      // A link to another folder is another profile.
      assert.equal((await withProfileSplit("hermes", safety, deps(other, link))).otherProfile, true, "a link to a different folder");
      // OpenClaw: a state folder reached through a link on one side.
      const claw = (shellEnv, serverEnv) =>
        withProfileSplit("openclaw", safety, { peekShell: () => shell(shellEnv), resolveHermesHome: async () => null, serverEnv, home: dir });
      assert.equal(await claw({ OPENCLAW_STATE_DIR: target }, { OPENCLAW_STATE_DIR: link }), safety, "OpenClaw's state folder through a link");
      assert.equal((await claw({ OPENCLAW_STATE_DIR: other }, { OPENCLAW_STATE_DIR: link })).otherProfile, true, "OpenClaw: two different folders");
    }
    // A folder that does not exist falls back to its text: different text is another profile, the same text is not.
    assert.equal((await withProfileSplit("hermes", safety, deps(path.join(dir, "nope-a"), path.join(dir, "nope-b")))).otherProfile, true);
    assert.equal(await withProfileSplit("hermes", safety, deps(path.join(dir, "nope-a"), path.join(dir, "nope-a"))), safety);
    // One side exists, the other does not: not the same folder.
    assert.equal((await withProfileSplit("hermes", safety, deps(target, path.join(dir, "nope-b")))).otherProfile, true);
    // A name (OPENCLAW_PROFILE) is not a path: compared as written, never looked up.
    const names = (a, b) => withProfileSplit("openclaw", safety, { peekShell: () => shell({ OPENCLAW_PROFILE: a }), resolveHermesHome: async () => null, serverEnv: { OPENCLAW_PROFILE: b }, home: dir });
    assert.equal((await names("work", "home")).otherProfile, true);
    assert.equal(await names("work", "work"), safety);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F1: it stays cheap, because it runs in a page request: no path is looked up when the text already agrees, and at most one pair per differing setting when it does not", async () => {
  const safety = { permissive: false, summary: "x", actions: [], known: true, notes: [] };
  const calls = [];
  const spy = async (p) => {
    calls.push(p);
    return p;
  };
  const base = { resolveHermesHome: async () => "/data/work", serverEnv: {}, home: "/Users/someone", realpath: spy };
  // The form the code looks a path up in: resolved, and on Windows with its drive and in lower case ("/data/work" reads d:\data\work).
  const looked = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  // The same text on both sides: nothing is looked up.
  assert.equal(await withProfileSplit("hermes", safety, { ...base, peekShell: () => shell({ HERMES_HOME: "/data/work/" }) }), safety);
  assert.deepEqual(calls, []);
  // Different text: the two paths, once each.
  await withProfileSplit("hermes", safety, { ...base, peekShell: () => shell({ HERMES_HOME: "/data/other" }) });
  assert.deepEqual(calls.sort(), [looked("/data/other"), looked("/data/work")]);
  // OpenClaw: only the variables whose text differs; a name is never looked up.
  calls.length = 0;
  await withProfileSplit("openclaw", safety, {
    ...base,
    peekShell: () => shell({ OPENCLAW_PROFILE: "a", OPENCLAW_STATE_DIR: "/s/one", OPENCLAW_HOME: "/h" }),
    serverEnv: { OPENCLAW_PROFILE: "b", OPENCLAW_STATE_DIR: "/s/two", OPENCLAW_HOME: "/h" }
  });
  assert.deepEqual(calls.sort(), [looked("/s/one"), looked("/s/two")]);
  // No claim, no lookup: the shell was not read, or the agent has no profile.
  calls.length = 0;
  await withProfileSplit("hermes", safety, { ...base, peekShell: () => null });
  await withProfileSplit("claude", safety, { ...base, peekShell: () => shell({ HERMES_HOME: "/x" }) });
  assert.deepEqual(calls, []);
  // A lookup that throws falls back to the text.
  const throwing = { ...base, peekShell: () => shell({ HERMES_HOME: "/data/other" }), realpath: async () => { throw new Error("EIO"); } };
  assert.equal((await withProfileSplit("hermes", safety, throwing)).otherProfile, true);
});

test("peekLoginShellEnv answers at once: null until the cached read has finished, then that read", async () => {
  // The stand-in login shell, never the developer's own.
  const hadShell = process.env.SHELL;
  process.env.SHELL = FAKE_LOGIN_SHELL;
  try {
    resetLoginShellEnvForTests();
    assert.equal(peekLoginShellEnv(), null, "nothing has been asked yet");
    const pending = getLoginShellEnv();
    assert.equal(peekLoginShellEnv(), null, "asked, not answered: a page request never waits for it");
    const answer = await pending;
    assert.equal(peekLoginShellEnv(), answer, "answered: that same answer");
    resetLoginShellEnvForTests();
    assert.equal(peekLoginShellEnv(), null, "reset clears it");
  } finally {
    resetLoginShellEnvForTests();
    if (hadShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = hadShell;
  }
});

test("source: the Agents detail route asks withProfileSplit, and the page's request never waits for the shell", () => {
  const routes = readFileSync(path.join(root, "server/runtime/agents/routes.js"), "utf8");
  assert.match(routes, /withProfileSplit\(/);
  const split = readFileSync(path.join(root, "server/runtime/agents/profile-split.js"), "utf8");
  assert.doesNotMatch(split, /getLoginShellEnv\(/, "only the cached answer is looked at, never the slow read");
  assert.match(split, /peekLoginShellEnv/);
});
