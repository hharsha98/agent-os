// "Choose in Hermes" (plan brains spec §4): opens Hermes's own model picker,
// `hermes model`, in its own Terminal.app window. Agent OS adds nothing of its
// own here. The window runs one fixed command line, `<detected hermes> model`,
// with the person's own shell and settings, so Hermes sees exactly what it sees
// in Terminal (H1, H2), and nothing typed or shown there passes through Agent
// OS. This never starts a session or a PTY and never changes Hermes's config;
// the Agents page reads what Hermes saved afterwards (readAgentModel).
//
// "Add a sign-in in Hermes" works the same way for Hermes's own credential
// helper, bare `hermes auth` (its interactive wizard for adding, listing and
// removing sign-ins): its own window, its own fixed line
// `<detected hermes> auth`, and the same promises. It lives in this module
// so both buttons share the one reviewed launch path: no new shell, no new argv
// path, and nothing from a request reaches either command or its file.
import { spawn } from "node:child_process";
import { ADAPTERS } from "../agents/index.js";
import { absoluteBinPath, openCommandInTerminal } from "./signin.js";

export const HERMES_MODEL_ARGS = Object.freeze(["model"]);
export const HERMES_TERMINAL_NAME = "hermes-model";
// Bare `auth`, not `auth add`: `hermes auth add` has a required <provider> argument, so with none it prints its
// usage and an error and exits at once, so no helper would ever open. Bare `hermes auth` is the "Interactive
// wizard" in Hermes's own CLI reference, where the person picks the provider and signs in.
export const HERMES_AUTH_ARGS = Object.freeze(["auth"]);
// A name of its own, so the two windows never share a .command file name or the
// "one launch at a time" guard: a sign-in helper can open while the picker is open.
export const HERMES_AUTH_TERMINAL_NAME = "hermes-auth";

const HERMES_NOT_INSTALLED_MESSAGE = "Hermes isn't installed on this computer yet.";

// Answers what openCommandInTerminal answers: { opened: true, command } on
// macOS, { opened: false, reason: "spawn_failed", command } when Terminal could
// not start, and { opened: false, reason: "copy", command } on Windows and
// Linux. Throws code "agent_not_installed" when Hermes can't be found. Only
// `platform` and `spawnFn` are read from the options; nothing a caller passes
// reaches the command, the file or the argv.
export function openHermesModelTerminal({ platform = process.platform, spawnFn = spawn } = {}) {
  return openHermesTerminal(HERMES_MODEL_ARGS, HERMES_TERMINAL_NAME, { platform, spawnFn });
}

// The same, for bare `hermes auth` (Hermes's own credential helper).
export function openHermesAuthTerminal({ platform = process.platform, spawnFn = spawn } = {}) {
  return openHermesTerminal(HERMES_AUTH_ARGS, HERMES_AUTH_TERMINAL_NAME, { platform, spawnFn });
}

async function openHermesTerminal(args, name, { platform, spawnFn }) {
  // A fresh look, never the 30 s detect cache, so a Hermes installed a moment ago is found.
  const detected = await ADAPTERS.hermes.detect({ refresh: true });
  if (!detected.installed || !detected.path) {
    const error = new Error(HERMES_NOT_INSTALLED_MESSAGE);
    error.code = "agent_not_installed";
    throw error;
  }
  return openCommandInTerminal(absoluteBinPath(detected.path, platform), args, { name, platform, spawnFn });
}
