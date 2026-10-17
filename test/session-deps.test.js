// The SP3 terminal packages (spec "Dependencies and packaging"; Task W0):
// each one is pinned to one exact version and installed; node-pty loads its
// prebuilt binary and runs a real program in a real terminal (a PTY); the
// server-side pieces (@xterm/headless with its serialize and unicode11
// addons, and ws) load and work in Node. Nothing here starts an agent.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

// One xterm.js release (git commit c58ea36, 2026-08-30), the set VS Code's
// main branch lists. Each xterm package numbers its own betas.
const EXACT_PINS = {
  "node-pty": "1.2.0-beta.14",
  ws: "8.22.0",
  "@xterm/xterm": "6.1.0-beta.304",
  "@xterm/headless": "6.1.0-beta.303",
  "@xterm/addon-serialize": "0.15.0-beta.301",
  "@xterm/addon-fit": "0.12.0-beta.301",
  "@xterm/addon-unicode11": "0.10.0-beta.301",
  "@xterm/addon-search": "0.17.0-beta.301",
  "@xterm/addon-web-links": "0.13.0-beta.301",
  "@xterm/addon-clipboard": "0.3.0-beta.303",
  "@xterm/addon-webgl": "0.20.0-beta.300"
};

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// The xterm packages are CommonJS bundles whose names ESM cannot see, so they
// are loaded the way the mirror (Task S4) loads them: the default import holds
// the classes. A named import (`import { Terminal } from "@xterm/headless"`)
// does not work.
async function loadXterm() {
  const { Terminal } = (await import("@xterm/headless")).default;
  const { SerializeAddon } = (await import("@xterm/addon-serialize")).default;
  const { Unicode11Addon } = (await import("@xterm/addon-unicode11")).default;
  return { Terminal, SerializeAddon, Unicode11Addon };
}

// Resolves once the terminal has parsed the data (xterm parses asynchronously).
function writeAll(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

// Runs one program in a real terminal and collects everything it printed.
async function runInPty(file, args, options) {
  const pty = require("node-pty");
  const term = pty.spawn(file, args, options);
  let output = "";
  term.onData((data) => {
    output += data;
  });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        term.kill();
      } catch {
        // already gone
      }
      reject(new Error(`no exit within 15 s; output so far: ${JSON.stringify(output)}`));
    }, 15000);
    term.onExit((info) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
  // The last bytes can arrive just after the exit event.
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Windows: node-pty keeps the ConPTY handle and its output thread until kill(), and without this the test file's
  // process never ends (seen in CI). The server does the same (releaseConptyAfterExit in pty-host.js).
  if (isWindows) {
    try {
      term.kill();
    } catch {
      // already released
    }
  }
  return { output, exit };
}

test("package.json pins every SP3 terminal package to one exact version, and that version is installed", () => {
  const pkg = readJson(path.join(root, "package.json"));
  for (const [name, version] of Object.entries(EXACT_PINS)) {
    assert.equal(pkg.dependencies?.[name], version, `package.json must pin ${name} to exactly ${version}`);
    const installed = path.join(root, "node_modules", ...name.split("/"), "package.json");
    assert.ok(existsSync(installed), `${name} is not installed; run npm ci`);
    assert.equal(readJson(installed).version, version, `installed version of ${name}`);
  }
});

test("node-pty loads as a named ESM export, as the default export and through require", async () => {
  const mod = await import("node-pty");
  assert.equal(typeof mod.default.spawn, "function");
  assert.equal(typeof mod.spawn, "function", "named export (pty-host.js may use either form)");
  assert.equal(require("node-pty").spawn, mod.default.spawn, "require and import give the same module");
});

test("node-pty uses its prebuilt binary for this computer (nothing was compiled)", () => {
  const pkgDir = path.join(root, "node_modules", "node-pty");
  const dir = path.join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`);
  assert.ok(existsSync(dir), `node-pty has no prebuilt binary for ${process.platform}-${process.arch}`);
  assert.ok(existsSync(path.join(dir, isWindows ? "conpty.node" : "pty.node")));
  if (process.platform === "darwin") {
    const helper = path.join(dir, "spawn-helper");
    assert.ok(existsSync(helper), "macOS needs spawn-helper beside pty.node");
    assert.notEqual(statSync(helper).mode & 0o111, 0, "spawn-helper must be executable, or every spawn fails");
  }
  // node-pty loads build/Release before prebuilds/, so a compiled copy would win.
  // (On Windows its post-install step copies conpty.dll into build/Release/conpty/;
  // that folder is expected and is not a compiled binary.)
  for (const folder of ["Release", "Debug"]) {
    for (const name of ["pty.node", "conpty.node", "conpty_console_list.node"]) {
      const compiled = path.join(pkgDir, "build", folder, name);
      assert.equal(existsSync(compiled), false, `node-pty was compiled from source (${compiled}) instead of using its prebuilt binary`);
    }
  }
});

test("node-pty runs a program in a real terminal and reports its exit code", async () => {
  const { output, exit } = isWindows
    ? await runInPty(process.env.ComSpec || "cmd.exe", ["/d", "/c", "echo pty-ok"], {
        cols: 80,
        rows: 24,
        cwd: os.tmpdir(),
        env: process.env
      })
    : await runInPty("/bin/echo", ["pty-ok"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: os.tmpdir(),
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" }
      });
  assert.match(output, /pty-ok/);
  assert.equal(exit.exitCode, 0);
});

test(
  "the program sees a terminal of the size we asked for, not a pipe",
  { skip: isWindows ? "test -t and stty are POSIX tools" : false },
  async () => {
    const { output, exit } = await runInPty(
      "/bin/sh",
      ["-c", "if test -t 0 && test -t 1; then echo is-a-tty; fi; stty size"],
      { name: "xterm-256color", cols: 100, rows: 30, cwd: os.tmpdir(), env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" } }
    );
    assert.match(output, /is-a-tty/);
    assert.match(output, /30 100/);
    assert.equal(exit.exitCode, 0);
  }
);

test("@xterm/headless and its serialize addon load in Node and copy a screen exactly", async () => {
  const { Terminal, SerializeAddon } = await loadXterm();
  assert.equal(require("@xterm/headless").Terminal, Terminal, "createRequire gives the same class");
  const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  await writeAll(term, "hello\r\n\x1b[1mbold\x1b[22m");
  const data = serializer.serialize();
  assert.match(data, /hello/);
  assert.match(data, /bold/);

  const copy = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
  await writeAll(copy, data);
  assert.equal(copy.buffer.active.getLine(0).translateToString(true), "hello");
  assert.equal(copy.buffer.active.getLine(1).translateToString(true), "bold");
  term.dispose();
  copy.dispose();
});

test("the unicode11 addon works on the headless terminal: an emoji takes two columns, as in the browser terminal", async () => {
  const { Terminal, Unicode11Addon } = await loadXterm();
  // Without the addon the headless terminal measures with Unicode 6, where this emoji is one column.
  const plain = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
  await writeAll(plain, "\u{1F642}x");
  assert.equal(plain.buffer.active.cursorX, 2);
  plain.dispose();

  const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  assert.ok(term.unicode.versions.includes("11"), `versions: ${term.unicode.versions.join(", ")}`);
  term.unicode.activeVersion = "11";
  await writeAll(term, "\u{1F642}x");
  assert.equal(term.buffer.active.cursorX, 3, "with Unicode 11 the emoji takes two columns, then x one");
  term.dispose();
});

test("ws loads with named and default ESM exports and echoes a message over a local WebSocket", async () => {
  const wsModule = await import("ws");
  const { WebSocket, WebSocketServer } = wsModule;
  assert.equal(wsModule.default, WebSocket, "the default export is the WebSocket class");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => socket.on("message", (data) => socket.send(`echo:${data}`)));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    await once(client, "open");
    client.send("hi");
    const [reply] = await once(client, "message");
    assert.equal(String(reply), "echo:hi");
  } finally {
    client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
