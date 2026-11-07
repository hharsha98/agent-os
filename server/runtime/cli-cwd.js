// The working folder for agent programs Agent OS starts only to read from or to set up (version checks, config reads,
// sign-in helpers, installers, live chat): a private, empty folder of its own, `<AGENT_OS_HOME>/cli-cwd`, mode 0700.
// The shared temp folder was used before. On Linux that folder is shared between accounts, so another account could leave
// a `.env` or `.claude/settings.json` there for a program that reads its working folder.
// Nothing is ever written into it by Agent OS, and it is made again when it is missing. If it cannot be made (a read-only
// disk), the temp folder is used as before rather than stopping every call.
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "./store.js";

export function cliCwd() {
  const dir = path.join(runtimePaths().root, "cli-cwd");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    return dir;
  } catch {
    return os.tmpdir();
  }
}
