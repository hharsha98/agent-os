// Prints the OpenRouter key Agent OS saved in its private folder, and nothing
// else. Claude Code's apiKeyHelper and Codex's provider `auth` command run this
// when they need the key, so the key never sits in a command line or an
// environment variable. The one argument is Agent OS's home folder.
// Prints nothing and exits 1 if there is no valid key.
import { readFileSync } from "node:fs";
import path from "node:path";

const home = process.argv[2];
try {
  if (!home || !path.isAbsolute(home)) process.exit(1);
  const key = readFileSync(path.join(home, "config", "secrets", "openrouter.key"), "utf8").trim();
  if (!/^sk-or-[A-Za-z0-9-]{10,200}$/.test(key)) process.exit(1);
  process.stdout.write(key);
} catch {
  process.exit(1);
}
