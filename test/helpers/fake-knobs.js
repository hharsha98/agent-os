// The knob files and the shared state file of the plan-brains fakes (spec
// docs/superpowers/specs/2026-10-15-plan-brains-design.md, "Testing"). A fake
// reads a knob FAKE_X from its environment, else from the trimmed text of
// $HOME/.fake-knobs/FAKE_X: Agent OS hands some commands only an allow-listed
// environment (childEnv), which drops FAKE_* variables, but it never changes
// HOME. $HOME/.fake-agent-state.json holds what the fake agents "saved":
// { primary, models, authRows }.
// A helper, not a test file: the runner only runs test/*.test.js.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const FAKE_KNOBS_DIR = ".fake-knobs";
export const FAKE_AGENT_STATE_FILE = ".fake-agent-state.json";
const KNOB_NAME = /^FAKE_[A-Z0-9_]+$/;

// Sets a knob for every fake that runs with this HOME; null removes it.
export async function setFakeKnob(home, name, value) {
  if (!KNOB_NAME.test(String(name))) throw new Error(`setFakeKnob: "${name}" is not a FAKE_* knob name`);
  const file = path.join(home, FAKE_KNOBS_DIR, name);
  if (value === null) {
    await rm(file, { force: true });
    return;
  }
  if (typeof value !== "string") throw new TypeError("setFakeKnob: the value is a string, or null to remove the knob");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

// The fakes' saved state; a missing or unreadable file reads as nothing saved yet.
export async function readFakeAgentState(home) {
  let value = null;
  try {
    value = JSON.parse(await readFile(path.join(home, FAKE_AGENT_STATE_FILE), "utf8"));
  } catch {
    value = null;
  }
  const state = { primary: null, models: null, authRows: [], ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}) };
  if (!Array.isArray(state.authRows)) state.authRows = [];
  return state;
}

export async function writeFakeAgentState(home, state) {
  await writeFile(path.join(home, FAKE_AGENT_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}
