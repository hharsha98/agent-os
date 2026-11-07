// server/runtime/safety.js: the key shapes redactText removes (review A-M4) and the environment runCommand gives the
// agent programs it only reads from (review Sa M3 / S-M1: no admin or launch token reaches them).
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { envWithoutServerSecrets, redactSecretShapes, redactText, redactValue, runCommand, runStreamingCommand } from "../server/runtime/safety.js";
import { taskLine } from "../server/runtime/runs/task-line.js";

// Built from pieces so this file holds no key-shaped text of its own.
const SHAPES = {
  "github fine-grained token": ["github", "_pat_", "A1b2C3d4E5f6G7h8I9j0K1"].join(""),
  "gitlab token": ["glpat", "-", "A1b2C3d4E5f6G7h8I9j0"].join(""),
  "aws access key": ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
  "groq key": ["gsk", "_", "A1b2C3d4E5f6G7h8I9j0K1"].join(""),
  "xai key": ["xai", "-", "A1b2C3d4E5f6G7h8I9j0K1"].join(""),
  "hugging face token": ["hf", "_", "A1b2C3d4E5f6G7h8I9j0K1L2M3N4O5P6"].join(""),
  "stripe live key": ["sk", "_live_", "A1b2C3d4E5f6G7h8I9j0"].join(""),
  "stripe restricted key": ["rk", "_live_", "A1b2C3d4E5f6G7h8I9j0"].join(""),
  "npm token": ["npm", "_", "A1b2C3d4E5f6G7h8I9j0K1L2M3N4O5P6"].join(""),
  "bearer token": ["Bearer", " ", "eyJhbGciOiJIUzI1NiJ9.payload.signature"].join("")
};
// The shapes that were already caught stay caught.
const OLD_SHAPES = {
  "openrouter key": ["sk", "-or-v1-", "A1b2C3d4E5f6G7h8"].join(""),
  "github classic token": ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1L2"].join(""),
  "slack token": ["xox", "b-", "1234567890-abc"].join(""),
  "google key": ["AI", "za", "A1b2C3d4E5f6G7h8I9j0K1L2"].join("")
};
const ORDINARY = [
  "npm_config_cache=/tmp/x",
  "hf_home is where models go",
  "xai-grok is a model name",
  "the bearer of news",
  "Bearer token",
  "an AKIA festival",
  "github_pat_ is only a prefix",
  "gsk_short",
  "glpat-short",
  "sk_live_short"
];

test("redactText removes every common key shape, old and new, wherever it sits in a line", () => {
  for (const [name, value] of Object.entries({ ...SHAPES, ...OLD_SHAPES })) {
    assert.equal(redactText(`before ${value} after`), "before configured after", name);
    assert.equal(redactSecretShapes(`key=${value}`).includes(value), false, `${name} (shapes only)`);
    assert.equal(String(redactValue("note", `x ${value} y`)).includes(value), false, `${name} (a value)`);
  }
});

test("redactText leaves ordinary words, short look-alikes and names that only start like a key alone", () => {
  for (const text of ORDINARY) assert.equal(redactText(text), text, text);
});

test("redactSecretShapes does not touch paths (a run's output keeps its full paths)", () => {
  const withHome = `${os.homedir()}/project/file.txt`;
  assert.equal(redactSecretShapes(withHome), withHome);
  assert.equal(redactText(withHome), "~/project/file.txt");
});

test("envWithoutServerSecrets drops the admin and launch tokens and any AGENT_OS_* or HERMES_AGENT_OS_* secret name, and keeps the rest", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    OPENAI_API_KEY: "kept: the person's own variable, not a server one",
    AGENT_OS_TOKEN: "t1",
    HERMES_AGENT_OS_ADMIN_TOKEN: "t2",
    AGENT_OS_HOOK_TOKEN: "t3",
    AGENT_OS_SOME_SECRET: "t4",
    HERMES_AGENT_OS_API_KEY: "t5",
    AGENT_OS_DB_PASSWORD: "t6",
    AGENT_OS_HOME: "/store",
    AGENT_OS_TEST_FAKE_KNOB: "on",
    HERMES_AGENT_OS_SCHEDULER: "0"
  };
  assert.deepEqual(envWithoutServerSecrets(env), {
    PATH: "/usr/bin",
    HOME: "/home/x",
    OPENAI_API_KEY: "kept: the person's own variable, not a server one",
    AGENT_OS_HOME: "/store",
    AGENT_OS_TEST_FAKE_KNOB: "on",
    HERMES_AGENT_OS_SCHEDULER: "0"
  });
});

test("runCommand's default environment hides the admin and launch tokens from a fake CLI but keeps its test knobs", { skip: process.platform === "win32" ? "a shell script stands in for the CLI" : false }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-runcommand-env-"));
  const saved = { ...process.env };
  try {
    const cli = path.join(dir, "fake-cli");
    await writeFile(cli, '#!/bin/sh\necho "admin=${HERMES_AGENT_OS_ADMIN_TOKEN-unset} launch=${AGENT_OS_TOKEN-unset} knob=${AGENT_OS_TEST_FAKE_KNOB-unset}"\n');
    await chmod(cli, 0o755);
    process.env.HERMES_AGENT_OS_ADMIN_TOKEN = "admin-secret-value";
    process.env.AGENT_OS_TOKEN = "launch-secret-value";
    process.env.AGENT_OS_TEST_FAKE_KNOB = "on";
    const seen = await runCommand(cli, [], 5000);
    assert.equal(seen.stdout, "admin=unset launch=unset knob=on");
    // A caller that passes its own environment gets exactly that.
    const own = await runCommand(cli, [], 5000, { env: { PATH: process.env.PATH, HERMES_AGENT_OS_ADMIN_TOKEN: "explicit" } });
    assert.equal(own.stdout, "admin=explicit launch=unset knob=unset");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test("runStreamingCommand's default environment hides the admin and launch tokens too, and a caller's own environment is used as given", { skip: process.platform === "win32" ? "a shell script stands in for the CLI" : false }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-streaming-env-"));
  const saved = { ...process.env };
  try {
    const cli = path.join(dir, "fake-cli");
    await writeFile(cli, '#!/bin/sh\necho "admin=${HERMES_AGENT_OS_ADMIN_TOKEN-unset} launch=${AGENT_OS_TOKEN-unset} knob=${AGENT_OS_TEST_FAKE_KNOB-unset}"\n');
    await chmod(cli, 0o755);
    process.env.HERMES_AGENT_OS_ADMIN_TOKEN = "admin-secret-value";
    process.env.AGENT_OS_TOKEN = "launch-secret-value";
    process.env.AGENT_OS_TEST_FAKE_KNOB = "on";
    const seen = await runStreamingCommand(cli, [], 5000);
    assert.equal(seen.stdout, "admin=unset launch=unset knob=on");
    const own = await runStreamingCommand(cli, [], 5000, { env: { PATH: process.env.PATH, HERMES_AGENT_OS_ADMIN_TOKEN: "explicit" } });
    assert.equal(own.stdout, "admin=explicit launch=unset knob=unset");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run's task line hides every key shape redactText hides (it uses the same list), and keeps ordinary words", () => {
  for (const [name, shape] of Object.entries({ ...SHAPES, ...OLD_SHAPES })) {
    const line = taskLine(`Use ${shape} to deploy`);
    assert.ok(!line.includes(shape), `${name} reached the saved task line`);
    assert.equal(line, redactText(`Use ${shape} to deploy`), name);
  }
  for (const word of ORDINARY) assert.equal(taskLine(word), redactText(word), word);
});
