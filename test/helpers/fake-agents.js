// Fake agent CLIs for the SP3 session tests (planning decision Q2). Each
// shim is a tiny POSIX shell script named like a real agent CLI that runs
// test/fakes/tui-agent.mjs with this Node, so node need not be on PATH.
// Put the folder first on a test's PATH, or pass a shim's path directly.
// This is a helper, not a test file: the runner only runs test/*.test.js.
// Importing it has no side effects (scripts/run-tests.mjs imports it too).
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fakesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fakes");

export const FAKE_AGENT_NAMES = Object.freeze(["claude", "codex", "agent", "cursor-agent", "hermes", "openclaw"]);
export const FAKE_AGENT_MODES = Object.freeze(["tui", "setsid-grandchild", "ignore-term", "agents-hang", "updater"]);
export const FAKE_AGENT_SCRIPT = path.join(fakesDir, "tui-agent.mjs");
// The stand-in login shell (planning decision Q1c): `<it> -i -l -c <command>`
// runs the command with /bin/sh, reads no startup file and keeps the
// environment as given. It is the only SHELL any test uses: the runner sets
// it for the whole run, and every test that starts server/index.js sets
// SHELL: FAKE_LOGIN_SHELL itself. Never /bin/sh: a real login sh runs macOS's
// path_helper, which puts /usr/local/bin and /opt/homebrew/bin first on PATH.
export const FAKE_LOGIN_SHELL = path.join(fakesDir, "login-shell.sh");

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Writes one executable shim per name into dir (created if missing).
// mode is the default FAKE_AGENT_MODE; a FAKE_AGENT_MODE in the environment
// the shim runs with wins. Resolves { dir, script, paths: { <name>: <file> } }.
// A file or link already at a shim's path is removed first: writing through a
// link (the UI audit harness's fake-bin/ links every name to one fake-agent
// file) would change the file it points at instead.
export async function makeFakeAgentBin(dir, { names = FAKE_AGENT_NAMES, mode = "tui" } = {}) {
  if (process.platform === "win32") {
    throw new Error("makeFakeAgentBin: the fake agents are POSIX shell shims; skip this test on Windows");
  }
  if (!FAKE_AGENT_MODES.includes(mode)) throw new Error(`makeFakeAgentBin: unknown fake agent mode "${mode}"`);
  await mkdir(dir, { recursive: true });
  const paths = {};
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`makeFakeAgentBin: bad agent name "${name}"`);
    const file = path.join(dir, name);
    const shim = [
      "#!/bin/sh",
      `FAKE_AGENT_NAME=${shQuote(name)}`,
      "export FAKE_AGENT_NAME",
      `: "\${FAKE_AGENT_MODE:=${mode}}"`,
      "export FAKE_AGENT_MODE",
      `exec ${shQuote(process.execPath)} ${shQuote(FAKE_AGENT_SCRIPT)} "$@"`,
      ""
    ].join("\n");
    await rm(file, { force: true });
    await writeFile(file, shim);
    await chmod(file, 0o755);
    paths[name] = file;
  }
  return { dir, script: FAKE_AGENT_SCRIPT, paths };
}
