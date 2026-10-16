// "Choose in Hermes" (plan brains spec §4): opens Hermes's own model picker,
// `hermes model`, in its own Terminal.app window. Agent OS adds nothing of its
// own here. The window runs one fixed command line, `<detected hermes> model`,
// with the person's own shell and settings, so Hermes sees exactly what it sees
// in Terminal (H1, H2), and nothing typed or shown there passes through Agent
// OS. This never starts a session or a PTY and never changes Hermes's config;
// the Agents page reads what Hermes saved afterwards (readAgentModel).
import { spawn } from "node:child_process";
import { ADAPTERS } from "../agents/index.js";
import { openCommandInTerminal } from "./signin.js";

export const HERMES_MODEL_ARGS = Object.freeze(["model"]);
export const HERMES_TERMINAL_NAME = "hermes-model";

const HERMES_NOT_INSTALLED_MESSAGE = "Hermes isn't installed on this computer yet.";

// Answers what openCommandInTerminal answers: { opened: true, command } on
// macOS, { opened: false, reason: "spawn_failed", command } when Terminal could
// not start, and { opened: false, reason: "copy", command } on Windows and
// Linux. Throws code "agent_not_installed" when Hermes can't be found. Only
// `platform` and `spawnFn` are read from the options; nothing a caller passes
// reaches the command, the file or the argv.
export async function openHermesModelTerminal({ platform = process.platform, spawnFn = spawn } = {}) {
  // A fresh look, never the 30 s detect cache, so a Hermes installed a moment ago is found.
  const detected = await ADAPTERS.hermes.detect({ refresh: true });
  if (!detected.installed || !detected.path) {
    const error = new Error(HERMES_NOT_INSTALLED_MESSAGE);
    error.code = "agent_not_installed";
    throw error;
  }
  return openCommandInTerminal(detected.path, HERMES_MODEL_ARGS, { name: HERMES_TERMINAL_NAME, platform, spawnFn });
}
