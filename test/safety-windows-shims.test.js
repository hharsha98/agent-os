// Agents installed with npm on Windows (final review, Se I2). npm puts three files side by side for each global program:
// `codex` (a shell script for POSIX), `codex.cmd` and `codex.ps1`. The search used to answer with the bare name, which
// Windows cannot start; and a .cmd cannot start without a shell (Node answers EINVAL), while this project starts programs
// with no shell on purpose (a folder name could become an argument). So: the search prefers the PATHEXT names, and a
// program that is an npm .cmd shim starts as the program the shim points at.
//
// The shim texts below are the exact output of npm's own cmd-shim (7.0.0, the one npm 10 ships), written with
// `cmdShim(target, shim)` for the targets named in each comment. Every pure function is tested here on any computer.
// The last test really starts a fake npm shim and runs only on Windows, where CI's Windows job runs it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { candidateNames, npmShimLaunch, parseNpmCmdShim, programLaunch, runCommand, which } from "../server/runtime/safety.js";
import { runCli } from "../server/runtime/sessions/soft-stop.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// node_modules/@openai/codex/bin/codex.js, first line "#!/usr/bin/env node" (a scoped package)
const CODEX_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
// node_modules/@anthropic-ai/claude-code/bin/claude.exe, a native program with no "#!" line
const CLAUDE_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
// node_modules/flagged/cli.js, first line "#!/usr/bin/env node --no-warnings"
const FLAGGED_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --no-warnings "%dp0%\\node_modules\\flagged\\cli.js" %*\r\n';
// node_modules/withvar/cli.js, first line "#!/usr/bin/env FOO=bar node": the shim sets a variable first
const WITHVAR_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n@SET FOO=bar\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\withvar\\cli.js" %*\r\n';
// "My Tools/tool/bin/tool.js" one folder up from the npm folder, first line "#!/usr/bin/env node" (a linked package with
// a space in its path)
const SPACED_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\My Tools\\tool\\bin\\tool.js" %*\r\n';
// The same text with Unix line ends (a checkout or an editor can change them).
const lf = (text) => text.replace(/\r\n/g, "\n");

const NPM_DIR = "C:\\Users\\Jo Smith\\AppData\\Roaming\\npm";
const CODEX_FILE = `${NPM_DIR}\\codex.cmd`;
const CODEX_SCRIPT = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;

test("on Windows the search tries the PATHEXT names first and the bare name last, so npm's `codex.cmd` beats its `codex` shell script", () => {
  const PATHEXT = ".COM;.EXE;.BAT;.CMD";
  assert.deepEqual(candidateNames("codex", "win32", PATHEXT), ["codex.COM", "codex.EXE", "codex.BAT", "codex.CMD", "codex"]);
  assert.deepEqual(candidateNames("codex", "win32", " .EXE ; ;.CMD "), ["codex.EXE", "codex.CMD", "codex"], "spaces and empty entries are ignored");
  assert.deepEqual(candidateNames("codex", "win32", ""), ["codex.COM", "codex.EXE", "codex.BAT", "codex.CMD", "codex"], "an empty PATHEXT falls back to the usual four");
  assert.deepEqual(candidateNames("codex.exe", "win32", PATHEXT), ["codex.exe"], "a name with an extension is looked up as it is");
  assert.deepEqual(candidateNames("codex", "darwin", PATHEXT), ["codex"], "POSIX has no PATHEXT");
  assert.deepEqual(candidateNames("codex", "linux", PATHEXT), ["codex"]);
});

test("parseNpmCmdShim reads the program an npm .cmd shim starts, from the exact text cmd-shim writes", () => {
  assert.deepEqual(parseNpmCmdShim(CODEX_CMD), { kind: "node", target: "node_modules\\@openai\\codex\\bin\\codex.js", flags: [] }, "a scoped package");
  assert.deepEqual(parseNpmCmdShim(CLAUDE_CMD), { kind: "exe", target: "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" }, "a native program");
  assert.deepEqual(parseNpmCmdShim(FLAGGED_CMD), { kind: "node", target: "node_modules\\flagged\\cli.js", flags: ["--no-warnings"] }, "the shebang's own flag");
  assert.deepEqual(parseNpmCmdShim(SPACED_CMD), { kind: "node", target: "..\\My Tools\\tool\\bin\\tool.js", flags: [] }, "a space in the path");
  assert.deepEqual(parseNpmCmdShim(lf(CODEX_CMD)), parseNpmCmdShim(CODEX_CMD), "Unix line ends read the same");
  assert.deepEqual(parseNpmCmdShim(`\ufeff${CODEX_CMD}`), parseNpmCmdShim(CODEX_CMD), "and so does a byte order mark");
});

test("parseNpmCmdShim answers null for anything it does not know, so that program fails as it did before", () => {
  const cases = {
    "a shim that sets a variable first": WITHVAR_CMD,
    "nothing": "",
    "a bare word": "codex",
    "the shell script npm writes beside it": '#!/bin/sh\nexec node "$basedir/node_modules/codex/bin/codex.js" "$@"\n',
    "a hand-written batch file": '@ECHO OFF\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\n"%NODE_EXE%" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n',
    "a target that is a batch file": CODEX_CMD.replace("codex.js", "codex.cmd"),
    "a target that is a PowerShell script": CODEX_CMD.replace("codex.js", "codex.ps1"),
    "a target with a variable in it": CODEX_CMD.replace("codex\\bin\\codex.js", "%COMSPEC%.js"),
    "an extra command in the head": CODEX_CMD.replace("SETLOCAL\r\n", "SETLOCAL\r\nDEL /Q C:\\x\r\n"),
    "an extra command after the launch line": `${CODEX_CMD}DEL /Q C:\\x\r\n`,
    "a flag with a quote in it": FLAGGED_CMD.replace("--no-warnings", '--x="y"'),
    "a flag with a variable in it": FLAGGED_CMD.replace("--no-warnings", "%PATH%"),
    "another interpreter": CODEX_CMD.replace('SET "_prog=node"', 'SET "_prog=python"'),
    "a launch line that does not end in %*": CODEX_CMD.replace(" %*", " --fixed")
  };
  for (const [name, text] of Object.entries(cases)) assert.equal(parseNpmCmdShim(text), null, name);
  for (const bad of [null, undefined, 42, {}]) assert.equal(parseNpmCmdShim(bad), null);
});

test("npmShimLaunch starts a node script with the node.exe beside the shim, else the node on the search path, else this program's own node, then the script and the original arguments", () => {
  const args = ["--version", "a b", 'say "hi"', "--", "-p"];
  const script = CODEX_SCRIPT;
  assert.deepEqual(npmShimLaunch(CODEX_FILE, CODEX_CMD, args, { nodeBeside: true, nodeOnPath: "C:\\Program Files\\nodejs\\node.exe", execPath: "C:\\Agent OS\\node.exe" }), {
    command: `${NPM_DIR}\\node.exe`,
    args: [script, ...args]
  }, "node.exe beside the shim wins, as the shim itself would choose it");
  assert.deepEqual(npmShimLaunch(CODEX_FILE, CODEX_CMD, args, { nodeBeside: false, nodeOnPath: "C:\\Program Files\\nodejs\\node.exe", execPath: "C:\\Agent OS\\node.exe" }), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: [script, ...args]
  }, "else the node on the search path");
  assert.deepEqual(npmShimLaunch(CODEX_FILE, CODEX_CMD, args, { nodeBeside: false, nodeOnPath: null, execPath: "C:\\Agent OS\\node.exe" }), {
    command: "C:\\Agent OS\\node.exe",
    args: [script, ...args]
  }, "else the node that runs Agent OS");
  assert.deepEqual(npmShimLaunch(CODEX_FILE, CODEX_CMD, [], { nodeBeside: true, execPath: "C:\\Agent OS\\node.exe" }), { command: `${NPM_DIR}\\node.exe`, args: [script] }, "no arguments");
  assert.deepEqual(
    npmShimLaunch(CODEX_FILE, FLAGGED_CMD, ["x"], { nodeBeside: true, execPath: "C:\\Agent OS\\node.exe" }),
    { command: `${NPM_DIR}\\node.exe`, args: ["--no-warnings", `${NPM_DIR}\\node_modules\\flagged\\cli.js`, "x"] },
    "the shim's own node flags come first"
  );
  assert.deepEqual(
    npmShimLaunch(CODEX_FILE.replace("codex.cmd", "tool.cmd"), SPACED_CMD, ["x"], { nodeBeside: false, nodeOnPath: null, execPath: "C:\\Agent OS\\node.exe" }),
    { command: "C:\\Agent OS\\node.exe", args: ["C:\\Users\\Jo Smith\\AppData\\Roaming\\My Tools\\tool\\bin\\tool.js", "x"] },
    "a path with a space and a .. in it"
  );
  // The inputs are never changed.
  const kept = ["--version"];
  npmShimLaunch(CODEX_FILE, CODEX_CMD, kept, { nodeBeside: true });
  assert.deepEqual(kept, ["--version"]);
});

test("npmShimLaunch starts a native program directly, and answers null for a shim it does not know", () => {
  const claude = "C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd";
  assert.deepEqual(npmShimLaunch(claude, CLAUDE_CMD, ["--version", "a b"], { nodeBeside: true, execPath: "C:\\Agent OS\\node.exe" }), {
    command: `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
    args: ["--version", "a b"]
  });
  assert.equal(npmShimLaunch(claude.replace("claude", "withvar"), WITHVAR_CMD, [], { nodeBeside: true }), null);
  assert.equal(npmShimLaunch(claude, "", [], {}), null);
});

test("programLaunch changes nothing except an npm .cmd shim on Windows", () => {
  const win = { platform: "win32", env: { Path: "C:\\tools;C:\\Program Files\\nodejs" }, execPath: "C:\\Agent OS\\node.exe" };
  const args = ["--version"];
  // Not Windows: never read anything.
  const reads = [];
  const read = (file) => {
    reads.push(file);
    return CODEX_CMD;
  };
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(programLaunch(CODEX_FILE, args, { ...win, platform, readText: read, exists: () => true }), { command: CODEX_FILE, args });
  }
  assert.deepEqual(reads, [], "nothing is read off Windows");
  // Windows, but not a .cmd or .bat: an .exe, or a bare name, is started as it is, and nothing is read.
  for (const other of ["C:\\x\\claude.exe", "C:\\x\\codex", "C:\\x\\codex.ps1", "codex"]) {
    assert.deepEqual(programLaunch(other, args, { ...win, readText: read, exists: () => true }), { command: other, args });
  }
  assert.deepEqual(reads, []);
  // A .cmd that is an npm shim: node.exe beside it.
  assert.deepEqual(programLaunch(CODEX_FILE, args, { ...win, readText: read, exists: (file) => file === `${NPM_DIR}\\node.exe` }), {
    command: `${NPM_DIR}\\node.exe`,
    args: [CODEX_SCRIPT, "--version"]
  });
  assert.deepEqual(reads, [CODEX_FILE], "the shim is read once");
  // ...else the node on the search path (the variable may be called Path), else this program's own node.
  assert.deepEqual(
    programLaunch(CODEX_FILE, args, { ...win, readText: () => CODEX_CMD, exists: (file) => file === "C:\\Program Files\\nodejs\\node.exe" }).command,
    "C:\\Program Files\\nodejs\\node.exe"
  );
  assert.equal(programLaunch(CODEX_FILE, args, { ...win, readText: read, exists: () => false }).command, "C:\\Agent OS\\node.exe");
  assert.equal(programLaunch(CODEX_FILE, args, { ...win, env: {}, readText: read, exists: () => false }).command, "C:\\Agent OS\\node.exe", "no PATH at all");
  // A .bat is read the same way; an unknown shim, an unreadable one and a read that throws come back unchanged.
  assert.equal(programLaunch("C:\\x\\codex.bat", args, { ...win, readText: read, exists: () => false }).command, "C:\\Agent OS\\node.exe");
  assert.deepEqual(programLaunch("C:\\x\\w.cmd", args, { ...win, readText: () => WITHVAR_CMD, exists: () => true }), { command: "C:\\x\\w.cmd", args });
  assert.deepEqual(programLaunch("C:\\x\\w.cmd", args, { ...win, readText: () => null, exists: () => true }), { command: "C:\\x\\w.cmd", args });
  assert.deepEqual(
    programLaunch("C:\\x\\w.cmd", args, {
      ...win,
      readText: () => {
        throw new Error("EACCES");
      },
      exists: () => true
    }),
    { command: "C:\\x\\w.cmd", args }
  );
  // A relative path is never a found program.
  assert.deepEqual(programLaunch("codex.cmd", args, { ...win, readText: read, exists: () => true }), { command: "codex.cmd", args });
});

test("source: every place that starts a found program asks programLaunch first (runCommand, the run manager, the terminal, runCli)", () => {
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  assert.match(read("server/runtime/safety.js"), /programLaunch\(command, args/, "runCommand");
  assert.match(read("server/runtime/runs/run-manager.js"), /programLaunch\(plan\.command, plan\.args/, "the run manager's spawn");
  assert.match(read("server/runtime/sessions/pty-host.js"), /programLaunch\(command, args/, "the terminal's spawn");
  assert.match(read("server/runtime/sessions/soft-stop.js"), /programLaunch\(command, args/, "runCli");
  assert.doesNotMatch(read("server/runtime/safety.js"), /shell:\s*true/, "still no shell");
});

// ---- A real start. Windows only: the shell scripts and .cmd files below are what npm writes there. ----------------

test("on Windows an npm shim really starts: the search finds the .cmd, and runCommand and runCli run its script", { skip: process.platform === "win32" ? false : "Windows only (npm's .cmd shims)" }, async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os npm shim ")));
  const npmDir = path.join(dir, "npm folder");
  const previousPath = process.env.PATH;
  try {
    const scriptDir = path.join(npmDir, "node_modules", "@fake", "tool", "bin");
    await mkdir(scriptDir, { recursive: true });
    // What the program prints: its arguments, so a space or a quote that got lost shows.
    await writeFile(path.join(scriptDir, "tool.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
    // npm's three files: the shell script (which Windows cannot start), the .cmd, and a PowerShell script.
    await writeFile(path.join(npmDir, "faketool"), '#!/bin/sh\nexec node "$0.js" "$@"\n');
    await writeFile(path.join(npmDir, "faketool.cmd"), CODEX_CMD.replace("node_modules\\@openai\\codex\\bin\\codex.js", "node_modules\\@fake\\tool\\bin\\tool.js"));
    await writeFile(path.join(npmDir, "faketool.ps1"), "# not used\n");
    process.env.PATH = `${npmDir}${path.delimiter}${previousPath}`;

    const found = await which("faketool");
    assert.equal(path.basename(found).toLowerCase(), "faketool.cmd", "the .cmd, not the shell script beside it");
    const wanted = ["--version", "a b", "c"];
    const ran = await runCommand(found, wanted, 20000);
    assert.equal(ran.ok, true, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), wanted);
    const cli = await runCli(found, wanted, { env: process.env });
    assert.equal(cli.ok, true);
    assert.deepEqual(JSON.parse(cli.stdout), wanted);
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
