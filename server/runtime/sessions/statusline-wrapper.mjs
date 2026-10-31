// Agent OS's statusLine wrapper (spec SP4 "Helper scripts" and H6; rulings R10 and K18), the only
// helper script Agent OS writes. A byte copy goes to <AGENT_OS_HOME>/sessions/<id>/statusline.mjs
// (0600) at every Claude Code start and resume, and the per-session settings file names it as
// Claude's statusLine command, run with the bundled Node's absolute path (the desktop app cannot
// rely on `node` being on PATH). Each time Claude refreshes its status line, this:
//   1. runs the person's own statusLine command (statusline.json next to this file) with
//      /bin/sh -c, the same stdin bytes, the unchanged environment and the current folder, as
//      Claude itself would, and copies its stdout byte for byte, then exits with that command's
//      exit code. With no command of the person's own it prints nothing and exits 0;
//   2. at the same time posts a copy of the stdin JSON to <AGENT_OS_HOOK_URL>/status with the
//      session's hook token, for the Live meter, waiting at most 500 ms from its own start: Claude
//      cancels a status line run when the next one starts, so a slow or stopped Agent OS must
//      never hide or delay the person's status line.
// It never prints anything of its own on stdout. Node built-ins only: it runs outside the repo.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATUS_POST_LIMIT_MS = 500;
// The hooks endpoint drops a bigger body unread (HOOK_BODY_LIMIT in hooks.js), so it is not sent.
const STATUS_BODY_LIMIT = 256 * 1024;
const LOCAL_HOOK_PREFIX = "http://127.0.0.1:";
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
// Once everything is done, Node exits by itself as soon as stdout is written. This only ends a
// run that something else keeps open (a reader that stopped reading).
const EXIT_BACKSTOP_MS = 2000;

// The person's own statusLine command, saved at session start; null without one or when unreadable.
function readUserCommand() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "statusline.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    return typeof config?.command === "string" && config.command.trim() ? config.command : null;
  } catch {
    return null;
  }
}

// Where the copy goes: only Agent OS's own local hook address, and only with a token.
function readPostTarget() {
  const url = process.env.AGENT_OS_HOOK_URL;
  const token = process.env.AGENT_OS_HOOK_TOKEN;
  if (typeof url !== "string" || !url.startsWith(LOCAL_HOOK_PREFIX) || typeof token !== "string" || !token) return null;
  try {
    const target = new URL(`${url}/status`);
    return target.protocol === "http:" && target.hostname === "127.0.0.1" ? { target, token } : null;
  } catch {
    return null;
  }
}

const command = readUserCommand();
const post = readPostTarget();
const input = [];
let child = null;
let commandDone = command === null;
let postDone = post === null;
let exitCode = 0;
let request = null;
let postTimer = null;
let finished = false;

function finishWhenDone() {
  if (finished || !commandDone || !postDone) return;
  finished = true;
  clearTimeout(postTimer);
  request?.destroy();
  process.stdin.destroy();
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), EXIT_BACKSTOP_MS).unref();
}

function sendCopy() {
  if (postDone) return;
  const body = Buffer.concat(input);
  const settle = () => {
    postDone = true;
    finishWhenDone();
  };
  if (body.length === 0 || body.length > STATUS_BODY_LIMIT) {
    settle();
    return;
  }
  try {
    request = http.request(
      post.target,
      {
        method: "POST",
        agent: false,
        headers: { Authorization: `Bearer ${post.token}`, "Content-Type": "application/json", "Content-Length": body.length }
      },
      (response) => {
        response.on("end", settle);
        response.on("close", settle);
        response.on("error", settle);
        response.resume();
      }
    );
  } catch {
    settle();
    return;
  }
  request.on("error", settle);
  request.end(body);
}

function startCommand() {
  const windows = process.platform === "win32";
  const shell = windows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = windows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command];
  try {
    child = spawn(shell, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
      windowsVerbatimArguments: windows
    });
  } catch {
    commandDone = true;
    exitCode = 1;
    return;
  }
  // The command need not read its input.
  child.stdin.on("error", () => {});
  child.stdout.pipe(process.stdout, { end: false });
  const done = (code) => {
    if (commandDone) return;
    commandDone = true;
    exitCode = typeof code === "number" ? code : 1;
    finishWhenDone();
  };
  child.once("error", () => done(1));
  // "close": the command ended and its output is complete (a status line ended by a signal is 1).
  child.once("close", (code) => done(code));
  const handlers = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        return;
      }
      // The command has ended and only its output is still open (a background process holds it).
      // A handler keeps Node alive on a signal, so end as the default action would instead.
      for (const [name, installed] of handlers) process.removeListener(name, installed);
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
}

// A reader that went away (a newer status line run replaced this one) is not an error here.
process.stdout.on("error", () => {});
if (command !== null) startCommand();
if (post !== null) {
  postTimer = setTimeout(() => {
    postDone = true;
    request?.destroy();
    finishWhenDone();
  }, STATUS_POST_LIMIT_MS);
}
process.stdin.on("data", (chunk) => {
  if (post !== null) input.push(chunk);
  if (child?.stdin.writable) child.stdin.write(chunk);
});
const inputEnded = () => {
  child?.stdin.end();
  if (post !== null) sendCopy();
};
process.stdin.once("end", inputEnded);
process.stdin.once("error", inputEnded);
finishWhenDone();
