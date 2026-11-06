// The launch token (final review, Sa M3 and Se M12). The desktop shell starts the server with AGENT_OS_TOKEN in its
// environment, and local-session.js reads it once at start. The server's own environment is the default for the agent
// programs it starts only to READ (detection, the version checks, the Hermes folder check, OpenClaw's config reads), so a
// plugin one of those programs loads could read the variable and use the whole API. The fix is to remove the variable from
// the server's environment right after the one read. Sessions, git and runs already get a clean environment of their own.
//
// Every reader was searched for: server/runtime/local-session.js is the only code that reads AGENT_OS_TOKEN (the Rust shell
// only sets it for the server it starts). A test process is used, because the module reads the variable when it loads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = (file) => pathToFileURL(path.join(root, file)).href;

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`))));
  });
}

// An environment with only what a Node process needs to start, plus the token.
const baseEnv = (extra) => ({ PATH: process.env.PATH, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}), ...extra });

test("the token is read once, then gone from the server's environment, so a program started for a read does not inherit it", async () => {
  const script = `
    import { sessionToken } from ${JSON.stringify(url("server/runtime/local-session.js"))};
    import { runCommand } from ${JSON.stringify(url("server/runtime/safety.js"))};
    // runCommand's default environment is the server's own: the one agent reads get.
    const child = await runCommand(process.execPath, ["-e", "process.stdout.write(String(process.env.AGENT_OS_TOKEN))"]);
    console.log(JSON.stringify({ token: sessionToken, own: process.env.AGENT_OS_TOKEN ?? null, child: child.stdout }));
  `;
  const out = JSON.parse(await runNode(script, baseEnv({ AGENT_OS_TOKEN: "pinned-token-from-the-shell" })));
  assert.equal(out.token, "pinned-token-from-the-shell", "the server still has the token it was started with");
  assert.equal(out.own, null, "and no longer holds it in its environment");
  assert.equal(out.child, "undefined", "a program the server starts for a read never sees it");
});

test("with no token pinned the server still makes its own random one, and nothing is left in the environment", async () => {
  const script = `
    import { sessionToken } from ${JSON.stringify(url("server/runtime/local-session.js"))};
    console.log(JSON.stringify({ length: sessionToken.length, own: process.env.AGENT_OS_TOKEN ?? null }));
  `;
  const out = JSON.parse(await runNode(script, baseEnv({})));
  assert.equal(out.length, 48);
  assert.equal(out.own, null);
});

test("source: local-session.js is the only server code that reads AGENT_OS_TOKEN, and it removes it right after", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const readers = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:js|mjs)$/.test(entry.name)) {
        const code = (await readFile(file, "utf8")).replace(/\/\/.*$/gm, "");
        if (/process\.env\.AGENT_OS_TOKEN|env\[["']AGENT_OS_TOKEN["']\]/.test(code)) readers.push(path.relative(root, file));
      }
    }
  }
  await walk(path.join(root, "server"));
  assert.deepEqual(readers.map((file) => file.split(path.sep).join("/")), ["server/runtime/local-session.js"]);
  const code = await readFile(path.join(root, "server/runtime/local-session.js"), "utf8");
  assert.match(code, /export const sessionToken = [^\n]+\n(?:\/\/[^\n]*\n)*delete process\.env\.AGENT_OS_TOKEN;/, "removed right after the one read, with only comment lines between");
});
