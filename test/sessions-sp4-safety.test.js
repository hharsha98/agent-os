// The SP4 safety rules as one guard over the final tree (SP4 plan, Task E1).
// Each rule is a source scan from test/helpers/sp4-source-scan.js. The first
// test proves every scan on bad fixtures, so a pass below means something,
// and a later change that breaks a rule fails here even when no behaviour
// test notices:
//   - Security 6: the only PTY writes are the mirror's query reply, the
//     writer's input and manager.typeInto (one write of the paste body, never
//     followed by Enter, never counted as user input);
//   - Security 4 and H2: only Claude Code sessions get AGENT_OS_HOOK_URL and
//     AGENT_OS_HOOK_TOKEN; the hook URL in the settings file is literal (R7);
//   - R16: OpenClaw is offered Allow once and Deny, never allow-always;
//   - R17, H1 and H3: no Hermes hook helper and no hooks folder;
//   - Screen reading: every screenText() call carries the label;
//   - H5, R6 and R27: the hooks router never answers with a body or a
//     decision, logs nothing and has its own error handler; nothing in the
//     server names onFailure;
//   - CLI calls: no forbidden flag in the new server modules, and no CLI is
//     handed process.env (it holds AGENT_OS_TOKEN).
// Pure reads of the repository: no server, no agent, no process.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APPROVAL_DECISIONS } from "../server/runtime/sessions/openclaw-approvals.js";
import { SESSION_AGENTS } from "../server/runtime/sessions/profiles.js";
import { sessionEnv } from "../server/runtime/sessions/shell-env.js";
import { runtimePaths } from "../server/runtime/store.js";
import { sourceProblems } from "./helpers/plan-brains-safety.js";
import {
  HANDS_PROCESS_ENV,
  SCREEN_READING_LABEL,
  enclosingFunction,
  filesNaming,
  functionBody,
  hookReplyProblems,
  linesMatching,
  ptyWriteSites,
  readSources,
  stripComments,
  unlabelledScreenReads
} from "./helpers/sp4-source-scan.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = "server/runtime/sessions";
const read = (file) => readFile(path.join(root, ...file.split("/")), "utf8");
const serverSources = () => readSources(root, "server");
const pageSources = () => readSources(root, "src", [".ts", ".tsx"]);

// Security 6 (spec): the four places a PTY is ever written, as "<file>#<the
// function the write sits in>".
const PTY_WRITE_PLACES = [
  `${SESSIONS}/manager.js#startProcess`, // onQueryReply: the mirror's standard query replies, only while no window is the writer
  `${SESSIONS}/manager.js#typeInto`, // the hand-off and the typed summaries, under the SP4 write rules
  `${SESSIONS}/manager.js#write`, // the writer's input ({t:"in"})
  `${SESSIONS}/pty-host.js#write` // the PTY handle's own write, which the three above call
];
// H2 and Security 4: the only server files that name the hook variables.
const HOOK_TOKEN_FILES = [`${SESSIONS}/claude-session.js`, `${SESSIONS}/shell-env.js`, `${SESSIONS}/statusline-wrapper.mjs`];
const HOOK_URL_FILES = [`${SESSIONS}/shell-env.js`, `${SESSIONS}/statusline-wrapper.mjs`];
// The server modules SP4 adds (contract, "Server modules").
const SP4_SERVER_MODULES = [
  "signals.js",
  "mirror-signals.js",
  "claude-session.js",
  "hooks.js",
  "statusline-wrapper.mjs",
  "claude-agents-poll.js",
  "openclaw-approvals.js",
  "git.js",
  "changes.js",
  "handoff.js",
  "worktrees.js",
  "keep-going.js"
].map((name) => `${SESSIONS}/${name}`);
// Those that start a CLI (an agent's or git), or hand work to one: none may pass
// process.env. The statusLine wrapper is not one of them: it runs the person's
// own status line with the unchanged environment on purpose (H6).
const CLI_MODULES = ["claude-agents-poll.js", "openclaw-approvals.js", "git.js", "changes.js", "worktrees.js", "handoff.js", "keep-going.js"].map(
  (name) => `${SESSIONS}/${name}`
);

test("the SP4 scans: each one finds its bad fixture and passes the good one", () => {
  const stripped = stripComments("a(); // note\n/* x\ny */ b();\n  // whole\nc('http://x');").split("\n");
  assert.deepEqual(stripped.map((line) => line.trim()), ["a();", "", "b();", "", "c('http://x');"], "comments go, line numbers stay");

  const lines = [
    "export async function outer(a) {",
    "  if (a) {",
    "    note(a);",
    "  }",
    "  const handle = {",
    "    write(data) {",
    "      child.write(data);",
    "    }",
    "  };",
    "}"
  ];
  assert.deepEqual(enclosingFunction(lines, 2), { name: "outer", index: 0 }, "an if block is not a function");
  assert.deepEqual(enclosingFunction(lines, 6), { name: "write", index: 5 }, "a method alone on its line is one");
  assert.equal(enclosingFunction(["const x = 1;"], 0), null);

  const manager = [
    "async function startProcess(state) {",
    "  state.mirror = mirrorFactory({",
    "    onQueryReply: (reply) => {",
    "      if (state.handle) state.handle.write(reply);",
    "    }",
    "  });",
    "  state.mirror.write(chunk);",
    "}",
    "function write(id, data) {",
    "  found.state.handle.write(data); // the writer's input",
    "}",
    "function typeInto(id, text) {",
    "  state.handle?.write(pasteBody(text));",
    "}",
    "function stop(id) {",
    '  // state.handle.write("\\x03") is never done',
    '  state.handle.write("\\r");',
    "}"
  ].join("\n");
  const sites = ptyWriteSites([{ file: "m.js", text: manager }]);
  assert.deepEqual(sites.map((site) => `${site.file}#${site.fn}`), ["m.js#startProcess", "m.js#write", "m.js#typeInto", "m.js#stop"]);
  assert.deepEqual(sites.map((site) => site.line), [4, 10, 13, 17], "the mirror's write and the commented-out write do not count");
  assert.match(functionBody(manager, "typeInto"), /pasteBody\(text\)/);
  assert.equal(functionBody(manager, "missing"), null);

  const named = [
    { file: "a.js", text: "env.AGENT_OS_HOOK_TOKEN = token;" },
    { file: "b.js", text: "// AGENT_OS_HOOK_TOKEN is never set here" },
    { file: "c.js", text: 'const name = "AGENT_OS_HOOK_TOKEN";' }
  ];
  assert.deepEqual(filesNaming(named, "AGENT_OS_HOOK_TOKEN"), ["a.js", "c.js"]);
  const always = [{ file: "x.ts", text: 'const ok = ["allow-once", "deny"];\nconst bad = "allow-always";' }];
  assert.deepEqual(linesMatching(always, /allow[-_ ]?always/i).map((hit) => hit.line), [2]);

  const reads = [
    `${SCREEN_READING_LABEL}: the limit text`,
    "function readLimitLine(state) {",
    "  return state.mirror.screenText();",
    "}",
    "function summary(state) {",
    "  return state.mirror.screenText();",
    "}",
    "function screenText(id) {",
    `  return live.get(id).mirror.screenText(); ${SCREEN_READING_LABEL}`,
    "}"
  ].join("\n");
  assert.deepEqual(unlabelledScreenReads([{ file: "r.js", text: reads }]).map((problem) => problem.line), [6]);

  assert.deepEqual(hookReplyProblems('res.status(204).set("Cache-Control", "no-store").end();\n// never a decision, never onFailure'), []);
  assert.deepEqual(hookReplyProblems('res.status(200).json({ decision: "approve" });'), ["answers with a JSON body", "names a decision"]);
  assert.deepEqual(hookReplyProblems('res.end("{}");\nconst entry = { onFailure: "ignore" };'), ["answers with a body", "names onFailure"]);

  assert.equal(HANDS_PROCESS_ENV.test("runCli(command, args, { env: profile.env, signal })"), false);
  for (const bad of ["runCli(command, args, { env: process.env })", "gitEnv({ ...process.env })", "gitEnv(process.env)"]) {
    assert.equal(HANDS_PROCESS_ENV.test(bad), true, bad);
  }
});

test("Security 6 (SP4): the only PTY writes are the mirror's query reply, the writer's input and manager.typeInto, which writes the paste body once and never counts as user input", async (t) => {
  const sites = ptyWriteSites(await serverSources());
  for (const site of sites) t.diagnostic(`pty write ${site.file}:${site.line} in ${site.fn}: ${site.text}`);
  assert.deepEqual(sites.map((site) => `${site.file}#${site.fn}`).sort(), [...PTY_WRITE_PLACES].sort());
  const typeInto = functionBody(await read(`${SESSIONS}/manager.js`), "typeInto");
  assert.ok(typeInto, "manager.js declares function typeInto(");
  assert.match(typeInto, /pasteBody\s*\(|PASTE_START[\s\S]*PASTE_END/, "the typed text is wrapped in the paste markers");
  assert.doesNotMatch(typeInto, /isUserInput\s*\(|type:\s*["']input["']|lastInputAt/, "a typed hand-off is never user input");
});

test("Security 4 and H2 (SP4): only Claude Code sessions get AGENT_OS_HOOK_URL and AGENT_OS_HOOK_TOKEN, only three server files name them, and the hook URL in the settings file is literal (R7)", async () => {
  const server = await serverSources();
  assert.deepEqual(filesNaming(server, "AGENT_OS_HOOK_TOKEN"), HOOK_TOKEN_FILES);
  assert.deepEqual(filesNaming(server, "AGENT_OS_HOOK_URL"), HOOK_URL_FILES);
  assert.equal(
    stripComments(await read(`${SESSIONS}/claude-session.js`)).includes("$AGENT_OS_HOOK_URL"),
    false,
    "Claude Code does not expand variables in a hook's url"
  );
  const hook = { url: "http://127.0.0.1:4100/hooks/sessions/e1-check", token: "e1-token" };
  const base = { PATH: "/usr/bin:/bin", AGENT_OS_HOOK_TOKEN: "left-over", AGENT_OS_HOOK_URL: "http://127.0.0.1:1/old" };
  for (const agentId of SESSION_AGENTS) {
    const env = sessionEnv(base, { sessionId: "e1-check", agentId, hook });
    const expected = agentId === "claude" ? [hook.url, hook.token] : [undefined, undefined];
    assert.deepEqual([env.AGENT_OS_HOOK_URL, env.AGENT_OS_HOOK_TOKEN], expected, agentId);
  }
  const withoutHook = sessionEnv(base, { sessionId: "e1-check", agentId: "claude" });
  assert.deepEqual([withoutHook.AGENT_OS_HOOK_URL, withoutHook.AGENT_OS_HOOK_TOKEN], [undefined, undefined], "Claude Code without a hook keeps SP3's environment");
});

test("R16: Agent OS offers OpenClaw only Allow once and Deny; nothing in the server or the page names allow-always", async () => {
  assert.deepEqual([...APPROVAL_DECISIONS], ["allow-once", "deny"]);
  assert.deepEqual(linesMatching([...(await serverSources()), ...(await pageSources())], /allow[-_ ]?always|allowAlways/i), []);
});

test("R17, H1 and H3: no Hermes hook helper or Hermes hook words, no hooks folder in AGENT_OS_HOME, and --accept-hooks only in the refusal list", async () => {
  const code = [...(await serverSources()), ...(await pageSources()), ...(await readSources(root, "scripts"))];
  assert.deepEqual(linesMatching(code, /hermes-hook|on_human_input_(?:request|resolved)|shell-hooks-allowlist/i), []);
  assert.deepEqual(filesNaming(code, "--accept-hooks"), [`${SESSIONS}/profiles.js`]);
  assert.equal(Object.hasOwn(runtimePaths(), "hooks"), false);
});

test("Screen reading (spec SP4): every screenText() call in the server sits under the SCREEN READING label", async (t) => {
  const server = await serverSources();
  let labels = 0;
  for (const { file, text } of server) {
    text.split("\n").forEach((line, index) => {
      if (!line.includes(SCREEN_READING_LABEL)) return;
      labels += 1;
      t.diagnostic(`label ${file}:${index + 1}`);
    });
  }
  assert.deepEqual(unlabelledScreenReads(server), []);
  assert.ok(labels >= 3, `X1b's two labels (the Claude and Codex limit texts) and X10's (the typed summary); found ${labels}`);
});

test("H5, R6 and R27: the hooks router never answers with a body or a decision, logs nothing and has its own error handler; nothing in the server names onFailure", async () => {
  const hooks = await read(`${SESSIONS}/hooks.js`);
  assert.deepEqual(hookReplyProblems(hooks), []);
  assert.match(stripComments(hooks), /\(\s*_?(?:err|error)\w*\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/, "an error handler of its own (four arguments)");
  assert.doesNotMatch(stripComments(hooks), /\bconsole\./, "nothing is logged");
  // X2a's settings guard is the one place that names onFailure, and only to
  // refuse a hook entry carrying it (E1 ruling, 2026-10-30).
  const server = await serverSources();
  assert.deepEqual(filesNaming(server, "onFailure"), ["server/runtime/builders/brain-launch.js"]);
  const guard = server.find(({ file }) => file === "server/runtime/builders/brain-launch.js");
  const naming = stripComments(guard.text).split("\n").filter((line) => line.includes("onFailure")).map((line) => line.trim());
  assert.deepEqual(naming, ['if (!isSessionHookUrl(handler.url) || "onFailure" in handler) refuse();']);
});

test("CLI calls (SP4): the new server modules exist, hold no forbidden flag, never hand process.env to a CLI, and OpenClaw calls never add --url or --token", async () => {
  for (const file of SP4_SERVER_MODULES) {
    const text = await read(file);
    assert.deepEqual(sourceProblems(text), [], file);
    if (CLI_MODULES.includes(file)) assert.doesNotMatch(stripComments(text), HANDS_PROCESS_ENV, file);
  }
  assert.doesNotMatch(stripComments(await read(`${SESSIONS}/openclaw-approvals.js`)), /["'`]--(?:url|token)["'`]/);
});
