// Source scans for the SP4 safety rules (SP4 plan, Task E1): spec Security 4
// and 6, H2 and H5; rulings R6, R7, R16, R17 and R27; the plan's Global
// Constraints "PTY writes", "Screen reading" and "CLI calls". Not a test
// file (npm test runs only test/*.test.js). Every scan takes source text, so
// test/sessions-sp4-safety.test.js proves each one on a bad fixture before it
// reads the real tree. Comments never count, except the screen-reading label,
// which is a comment on purpose.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const SCREEN_READING_LABEL = "// SCREEN READING (spec SP4)";

// A write into a PTY: the pty-host handle's own `child.write(`, or a call on a
// session's handle (`state.handle.write(`, `handle?.write(`). The mirror's
// `state.mirror.write(` is the server's own copy of the screen, not the PTY.
export const PTY_WRITE = /\b(?:handle|child)\??\.write\(/;

// A CLI handed the server's own environment, which holds AGENT_OS_TOKEN.
export const HANDS_PROCESS_ENV = /\benv\s*:\s*process\.env\b|\.\.\.\s*process\.env\b|\(\s*process\.env\s*[,)]/;

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "function", "return"]);
const FUNCTION_DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
const METHOD_DECLARATION = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{\s*$/;
const CLOSING_LINE = /^\s*\}\s*[;,)]*\s*$/;

// The code with every comment blanked and every line kept, so line numbers
// stay true: /* ... */ blocks (their line breaks stay), whole-line // and *
// comments, and a // that follows a space ("http://" inside a string stays).
export function stripComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? "" : line.replace(/(^|\s)\/\/(\s.*)?$/, "$1")))
    .join("\n");
}

// Where line `index` (0-based) of `lines` sits: the nearest function
// declaration at or above it, written `function name(` or as a method
// `name(args) {` alone on its line, as { name, index }; null at the top level.
// Arrow functions do not count, so the query reply's `onQueryReply: (reply) =>`
// belongs to the function around it (startProcess).
export function enclosingFunction(lines, index) {
  for (let at = index; at >= 0; at -= 1) {
    const found = FUNCTION_DECLARATION.exec(lines[at]) || METHOD_DECLARATION.exec(lines[at]);
    if (found && !KEYWORDS.has(found[1])) return { name: found[1], index: at };
  }
  return null;
}

// The text of `function name(` in `text`, comments blanked, from its
// declaration to the closing brace at the same indent; null when there is none.
export function functionBody(text, name) {
  const lines = stripComments(text).split("\n");
  const declaration = new RegExp(`^(\\s*)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = lines.findIndex((line) => declaration.test(line));
  if (start < 0) return null;
  const indent = declaration.exec(lines[start])[1];
  const end = lines.findIndex((line, at) => at > start && line === `${indent}}`);
  return end < 0 ? null : lines.slice(start, end + 1).join("\n");
}

// Every PTY write in `files` ([{ file, text }]), one per line that has one:
// { file, line (1-based), fn (the function it sits in, or null), text }.
export function ptyWriteSites(files) {
  const sites = [];
  for (const { file, text } of files) {
    const lines = stripComments(text).split("\n");
    lines.forEach((line, index) => {
      if (!PTY_WRITE.test(line)) return;
      sites.push({ file, line: index + 1, fn: enclosingFunction(lines, index)?.name ?? null, text: line.trim() });
    });
  }
  return sites;
}

// The files, in the order given, whose code (comments blanked) contains `word`.
export function filesNaming(files, word) {
  return files.filter(({ text }) => stripComments(text).includes(word)).map(({ file }) => file);
}

// Every line whose code (comments blanked) matches `pattern` (a RegExp without
// the g flag): { file, line (1-based), text }.
export function linesMatching(files, pattern) {
  const hits = [];
  for (const { file, text } of files) {
    stripComments(text)
      .split("\n")
      .forEach((line, index) => {
        if (pattern.test(line)) hits.push({ file, line: index + 1, text: line.trim() });
      });
  }
  return hits;
}

// Every screenText( call (a definition does not count) with no screen-reading
// label between its own line and the line of its function's declaration, or up
// to three lines above that declaration (never past the end of the function
// before it): { file, line (1-based), text }.
export function unlabelledScreenReads(files) {
  const problems = [];
  for (const { file, text } of files) {
    const raw = String(text).split("\n");
    const code = stripComments(text).split("\n");
    code.forEach((line, index) => {
      if (!/\bscreenText\s*\(/.test(line)) return;
      if (/\bfunction\s+screenText\s*\(/.test(line) || /^\s*screenText\s*\([^()]*\)\s*\{\s*$/.test(line)) return;
      const inside = enclosingFunction(code, index);
      let from = inside ? inside.index : index;
      for (let step = 0; step < 3 && from > 0 && !CLOSING_LINE.test(code[from - 1]); step += 1) from -= 1;
      if (!raw.slice(from, index + 1).some((rawLine) => rawLine.includes(SCREEN_READING_LABEL))) {
        problems.push({ file, line: index + 1, text: line.trim() });
      }
    });
  }
  return problems;
}

// What the hooks router must never do (H5, R6): answer with a body, or name a
// decision or onFailure. One phrase per problem, in this order; [] when clean.
export function hookReplyProblems(text) {
  const code = stripComments(text);
  const checks = [
    ["answers with a JSON body", /\.json\s*\(/],
    ["answers with a body", /\.send\s*\(\s*[^)\s]|\.write\s*\(|\.end\s*\(\s*[^)\s]/],
    ["names a decision", /\b(?:decision|permissionDecision|hookSpecificOutput)\b/],
    ["names onFailure", /\bonFailure\b/]
  ];
  return checks.filter(([, pattern]) => pattern.test(code)).map(([problem]) => problem);
}

// Every file under `dir` (relative to `root`) whose name ends with one of
// `extensions`, as { file, text }, with `file` in forward-slash form and the
// list sorted, so expectations read the same on every system. node_modules and
// dot folders are skipped.
export async function readSources(root, dir, extensions = [".js", ".mjs"]) {
  const found = [];
  async function walk(relative) {
    const entries = await readdir(path.join(root, ...relative.split("/")), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push({ file: next, text: await readFile(path.join(root, ...next.split("/")), "utf8") });
      }
    }
  }
  await walk(dir);
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
