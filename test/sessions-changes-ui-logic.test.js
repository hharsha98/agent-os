// Task U7 (SP4): the changes panel's pure logic (src/ui/changesShared.ts) and its wiring: which sessions show Files
// changed, how often the panel asks, the section's words in every state, one row's words, how a diff's lines are told
// apart, and that the diff dialog is read-only. Node strips the TypeScript types itself (decision P14), so the .ts file
// is imported directly; it keeps only `import type` imports. No server, no browser: the section and the dialog are
// checked on the page by the changes probe (.superpowers/ui-audit/probes/changes.mjs), the server's git reads by Task
// X7's test/sessions-changes.test.js, and getChanges / getDiff by test/sessions-api.test.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as ch from "../src/ui/changesShared.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const SPEC = read("docs/superpowers/specs/2026-10-11-cobalt-redesign-and-real-terminals-design.md");
const AT = "2026-10-29T12:00:00.000Z";
const MINUS = "−";
const file = (over = {}) => ({ path: "src/app.ts", status: "modified", added: 12, removed: 3, ...over });
const result = (over = {}) => ({ git: true, files: [file()], total: 1, at: AT, ...over });
const ok = (data, stale = false) => (stale ? { state: "ok", data, stale: true } : { state: "ok", data });
const session = (over = {}) => ({ kind: "agent", status: "live", folderShown: true, ...over });

test("the not-git line is the spec's sentence, word for word; the other words are the decided ones and stay true", () => {
  assert.equal(ch.NOT_GIT_LINE, "Changes appear when this folder is a git project");
  assert.ok(SPEC.includes(`- not a git folder: "${ch.NOT_GIT_LINE}".`), "the spec's Changes panel line");
  // The prototype's words for an empty list (sessions.html), owner review at E1 (Q32).
  assert.equal(ch.NO_CHANGES_LINE, "No files changed in this session.");
  assert.equal(ch.NO_CHANGES_COPY_LINE, "No files changed in this copy yet.");
  // The Sessions page's own stale words, reused.
  assert.equal(ch.STALE_LINE, "Showing what was last known.");
  assert.ok(read("src/pages/SessionsPage.tsx").includes(ch.STALE_LINE), "the same words as the page's stale banner");
  // New sentences (Q32).
  assert.equal(ch.DIFF_LOADING, "Loading…");
  assert.equal(ch.DIFF_BINARY_LINE, "This is a binary file, so there is no text to show.");
  assert.equal(ch.DIFF_EMPTY_LINE, "There is no text difference to show for this file.");
  assert.equal(ch.DIFF_CUT_LINE, "This diff is long, so only its first 256 KB is shown.");
  // The cut sentence names the server's limit (Task X7), so the two must agree.
  assert.match(read("server/runtime/sessions/changes.js"), /export const DIFF_MAX_BYTES = 256 \* 1024\b/);
  for (const line of [ch.NOT_GIT_LINE, ch.NO_CHANGES_LINE, ch.NO_CHANGES_COPY_LINE, ch.STALE_LINE, ch.DIFF_BINARY_LINE, ch.DIFF_EMPTY_LINE, ch.DIFF_CUT_LINE]) {
    assert.doesNotMatch(line, /—/, `no em dash in "${line}"`);
  }
});

test("which sessions show Files changed, and how often the panel asks: every 3 s while it runs, never again once it has ended", () => {
  assert.equal(ch.CHANGES_UI_POLL_MS, 3000);
  assert.match(read("server/runtime/sessions/changes.js"), /export const CHANGES_POLL_MS = 3000\b/, "the panel asks as often as the server reads git");
  assert.equal(ch.showsChanges(session()), true);
  assert.equal(ch.showsChanges(session({ folderShown: false })), false, "OpenClaw picks its own folder: Agent OS can't say which files it changed");
  assert.equal(ch.showsChanges(session({ kind: "update" })), false);
  assert.equal(ch.showsChanges(session({ kind: "setup" })), false);
  assert.equal(ch.showsChanges(session({ status: "exited" })), true, "an ended session still shows what it changed");
  for (const status of ["starting", "live", "waiting", "idle", "held"]) assert.equal(ch.changesPollMs({ status }), 3000, status);
  assert.equal(ch.changesPollMs({ status: "exited" }), null, "ended: read once, no polling");
});

test("the section's words: loading, a first read that failed, not a git project, nothing changed (a copy says so), the files, more than 200, a failed read after a good one", () => {
  const waiting = { count: "…", line: null, files: [], more: null, stale: false };
  assert.deepEqual(ch.changesView({ state: "loading" }, { copy: false }), waiting);
  assert.deepEqual(ch.changesView(ok(result({ git: null, files: [], total: 0, at: null })), { copy: false }), waiting, "the server has not read git yet");
  assert.deepEqual(ch.changesView({ state: "error", message: "Couldn't reach Agent OS." }, { copy: false }), { ...waiting, line: "Couldn't reach Agent OS." });
  assert.deepEqual(ch.changesView(ok(result({ git: false, files: [], total: 0 })), { copy: false }), { count: null, line: ch.NOT_GIT_LINE, files: [], more: null, stale: false }, "not git: the line, and no count");
  assert.deepEqual(ch.changesView(ok(result({ files: [], total: 0 })), { copy: false }), { count: "0", line: ch.NO_CHANGES_LINE, files: [], more: null, stale: false });
  assert.equal(ch.changesView(ok(result({ files: [], total: 0 })), { copy: true }).line, ch.NO_CHANGES_COPY_LINE, "a separate copy (Task X9's copyOf)");
  const two = [file(), file({ path: "README.md", added: 1, removed: 0 })];
  assert.deepEqual(ch.changesView(ok(result({ files: two, total: 2 })), { copy: false }), { count: "2", line: null, files: two, more: null, stale: false });
  const capped = Array.from({ length: 200 }, (_, i) => file({ path: `f${i}.ts` }));
  const big = ch.changesView(ok(result({ files: capped, total: 1234 })), { copy: false });
  assert.equal(big.count, "1234", "the count is every changed file");
  assert.equal(big.files.length, 200);
  assert.equal(big.more, "Showing 200 of 1234 files.");
  assert.equal(ch.changesView(ok({ git: true, files: two, at: AT }), { copy: false }).count, "2", "no total: the list's own length");
  assert.equal(ch.changesView(ok(result({ files: two, total: 1 })), { copy: false }).more, null, "a total below the list's length is not believed");
  const stale = ch.changesView(ok(result({ files: two, total: 2 }), true), { copy: false });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.files, two, "the last good list stays");
  assert.equal(ch.changesView(ok(result({ git: false, files: [], total: 0 }), true), { copy: false }).stale, true);
  // Added by the worker (Deviations in the U7 report): `git: null` that goes on (X7: git is failing or slow in that
  // folder, or an ended session's one read was cut) is said in the page's own existing words, not "…" for ever.
  assert.equal(ch.UNREAD_LINE, "Agent OS couldn't do that. Try again.");
  assert.ok(read("src/sessionsApi.ts").includes(ch.UNREAD_LINE), "the same words as sessionProblem's fallback");
  assert.deepEqual([ch.changesUnread(true, 0), ch.changesUnread(true, 1)], [false, true], "an ended session is read once: its first such answer is the last");
  assert.deepEqual([ch.changesUnread(false, ch.UNREAD_AFTER_READS - 1), ch.changesUnread(false, ch.UNREAD_AFTER_READS)], [false, true], "a running one keeps trying for a while");
  assert.deepEqual(ch.changesView(ok(result({ git: null, files: [], total: 0, at: null })), { copy: false, unread: true }), { count: "—", line: ch.UNREAD_LINE, files: [], more: null, stale: false });
});

test("a row: the folder part and the name, + and − counts (a real minus sign), — when git can't count, the full path as its tooltip (a rename shows both), and its accessible name", () => {
  assert.deepEqual(ch.splitPath("src/ui/app.ts"), { dir: "src/ui/", name: "app.ts" });
  assert.deepEqual(ch.splitPath("README.md"), { dir: "", name: "README.md" });
  assert.deepEqual(ch.fileCounts(file()), { add: "+12", del: `${MINUS}3`, delZero: false });
  assert.deepEqual(ch.fileCounts(file({ added: 0, removed: 0 })), { add: "+0", del: `${MINUS}0`, delZero: true });
  assert.equal(ch.fileCounts(file({ added: null, removed: null })), null, "a binary file: git can't count its lines, the row shows —");
  assert.deepEqual(ch.fileCounts(file({ added: 3, removed: null })), { add: "+3", del: null, delZero: false }, "a count git didn't give is left out, never shown as 0");
  assert.equal(ch.fileCounts(file()).del.codePointAt(0), 0x2212, "a real minus sign, as in the prototype");
  assert.equal(ch.fileRowLabel(file()), "src/app.ts, 12 added, 3 removed");
  assert.equal(ch.fileRowLabel(file({ path: "notes/todo.txt", added: 3, removed: null })), "notes/todo.txt, 3 added");
  assert.equal(ch.fileRowLabel(file({ path: "logo.png", added: null, removed: null })), "logo.png, line counts unknown");
  assert.equal(ch.fileRowTitle(file()), "src/app.ts");
  assert.equal(ch.fileRowTitle(file({ status: "renamed", oldPath: "src/old.ts" })), "src/old.ts → src/app.ts");
});

test("diff lines: the header, hunk headers, added, removed and unchanged lines; a removed line that starts with -- stays removed; the next file starts a new header", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 83db48f..bf269f4 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,4 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "--- not a header, a removed line",
    "+const b = 3;\r",
    "+++ not a header, an added line",
    "\\ No newline at end of file",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    ""
  ].join("\n");
  const lines = ch.diffLines(diff);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["meta", "meta", "meta", "meta", "hunk", "context", "del", "del", "add", "add", "meta", "meta", "meta", "meta", "hunk", "del", "add"]
  );
  assert.equal(lines[8].text, "+const b = 3;", "a Windows line ending is not shown");
  assert.equal(lines.length, 17, "the final newline adds no empty line");
  assert.deepEqual(ch.diffLines(""), []);
});

test("a diff's notes: binary (no text at all), nothing to show, cut at the server's limit", () => {
  const text = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";
  assert.deepEqual(ch.diffView({ diff: text, binary: false, cut: false }).notes, []);
  assert.equal(ch.diffView({ diff: text, binary: false, cut: false }).lines.length, 6);
  assert.deepEqual(ch.diffView({ diff: "Binary files a/logo.png and b/logo.png differ\n", binary: true, cut: false }), { lines: [], notes: [ch.DIFF_BINARY_LINE] });
  assert.deepEqual(ch.diffView({ diff: "", binary: false, cut: false }), { lines: [], notes: [ch.DIFF_EMPTY_LINE] });
  const cut = ch.diffView({ diff: text, binary: false, cut: true });
  assert.deepEqual(cut.notes, [ch.DIFF_CUT_LINE]);
  assert.equal(cut.lines.length, 6, "a cut diff still shows what came");
});

test("wiring: the section sits after the Live meter, keyed by session; it polls with useInterval, one read at a time; the diff is read-only with Close as its only button", () => {
  const panel = read("src/ui/components/SessionSidePanel.tsx");
  assert.ok(panel.includes("<SessionChanges key={session.id} session={session} />"), "keyed by session: a switch never shows another session's list");
  const meterAt = panel.indexOf('aria-label="Live meter"');
  const changesAt = panel.indexOf("<SessionChanges ");
  const footAt = panel.indexOf('<footer className="os-sess-panel__foot">');
  assert.ok(meterAt > 0 && changesAt > meterAt && footAt > changesAt, "after the Live meter, in the scroll area, before the footer (spec side panel order)");
  const section = read("src/ui/components/SessionChanges.tsx");
  assert.match(section, /if \(!showsChanges\(session\)\) return null;/);
  assert.match(section, /createLatestRead/, "one read at a time, the newest answer wins");
  assert.match(section, /useInterval\(\(\) => load\(false\), changesPollMs\(session\)\)/, "every 3 s while it runs, paused while the window is hidden");
  assert.match(section, /getChanges\(session\.id\)/);
  assert.match(section, /failedLoad\(/, "a failed read after a good one keeps the list");
  assert.match(section, /return \(\) => reads\.cancel\(\);/, "a read still waiting when the section goes away no longer counts");
  assert.match(section, /aria-label="Files changed"/);
  assert.match(section, /<li key=\{file\.path\}>/, "a row keeps its button across reads, so the focus can come back to it");
  assert.match(section, /aria-haspopup="dialog"/);
  assert.match(section, /aria-label=\{fileRowLabel\(file\)\}/);
  assert.match(section, /<DiffDialog /);
  assert.doesNotMatch(section, /<h[1-6]/, "no second heading in the panel (its h2 is the folder)");
  const dialog = read("src/ui/components/DiffDialog.tsx");
  assert.match(dialog, /<AgentConfirmModal\s[^>]*cancelLabel="Close"/);
  assert.doesNotMatch(dialog, /onConfirm=/, "nothing to confirm: Close is its only button");
  assert.match(dialog, /getDiff\(sessionId, file\.path\)/);
  assert.match(dialog, /changeMissing\(error\)/, "a file that left the changes reads the list again");
  assert.match(dialog, /let alive = true;/, "no update after the dialog closed");
  assert.match(dialog, /tabIndex=\{0\}/, "the diff box can be scrolled with the keyboard");
  for (const editable of [/dangerouslySetInnerHTML/, /contentEditable/i, /<textarea/, /<input/]) assert.doesNotMatch(dialog, editable, `read-only: ${editable}`);
  const modal = read("src/ui/components/AgentConfirmModal.tsx");
  assert.match(modal, /onConfirm\?: \(\) => void;/);
  assert.match(modal, /\{onConfirm \? \(/, "the confirm button only when there is something to confirm");
});

test("the styles: tokens only, + green and − red, a long path ends in …, the diff dialog wider than a question with Close on screen, long lines wrapped, nothing moves", () => {
  const css = read("src/ui/sessions.css");
  const start = css.indexOf("/* ---- Files changed and the read-only diff");
  const end = css.indexOf("/* ---- end Files changed", start);
  assert.ok(start > 0 && end > start, "the block is in sessions.css, between its two marker comments");
  const block = css.slice(start, end);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, "colours come from tokens.css only");
  assert.match(block, /\.os-sess-file__add \{\s*color: var\(--os-ok\);/);
  assert.match(block, /\.os-sess-file__del \{\s*color: var\(--os-danger\);/);
  assert.match(block, /\.os-sess-file__path \{[^}]*text-overflow: ellipsis;/, "a long path ends in …");
  assert.match(block, /\.os-modal:has\(\.os-diff-view\) \{\s*width: min\(880px, 100%\);/);
  assert.match(block, /\.os-diff \{[^}]*max-height: min\(60svh, 560px\);/, "Close stays on screen at 1280×720");
  assert.match(block, /\.os-diff \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/, "long diff lines wrap: no sideways scroll");
  assert.doesNotMatch(block, /transition|animation/, "nothing moves");
});

// ---------------------------------------------------------------------------
// Fix round 1 (review of Task U7)
// ---------------------------------------------------------------------------

test("hidden characters are made visible: reordering and format characters as <U+XXXX>, control characters as \\xNN, everything else untouched", () => {
  const tokens = (text) => ch.visiblePieces(text).filter((piece) => piece.hidden).map((piece) => piece.text);
  // A right-to-left override inside a file name: raw, "report\u202Efdp.exe" is drawn as "reportexe.pdf".
  assert.deepEqual(ch.visiblePieces("docs/report\u202Efdp.exe"), [
    { text: "docs/report", hidden: false, label: null },
    { text: "<U+202E>", hidden: true, label: "hidden character U+202E" },
    { text: "fdp.exe", hidden: false, label: null }
  ]);
  assert.equal(ch.visibleText("docs/report\u202Efdp.exe"), "docs/report<U+202E>fdp.exe");
  // Trojan Source style line (CVE-2021-42574): the override and isolates hide what the line really holds.
  const trojan = "/* \u202E } \u2066if (isAdmin)\u2069 \u2066 begin admins only */";
  assert.equal(ch.visibleText(trojan), "/* <U+202E> } <U+2066>if (isAdmin)<U+2069> <U+2066> begin admins only */");
  assert.deepEqual(tokens(trojan), ["<U+202E>", "<U+2066>", "<U+2069>", "<U+2066>"]);
  // A NUL and an ESC (a terminal colour code), a DEL, a C1 control, a lone carriage return, a newline in a name.
  assert.equal(ch.visibleText("a\u0000b\u001B[31mc"), "a\\x00b\\x1B[31mc");
  assert.equal(ch.visibleText("x\u007Fy\u0085z\rw\nv"), "x\\x7Fy\\x85z\\x0Dw\\x0Av");
  // Every character the ruling names, one token each (the label says which character it is).
  const named = [0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
  for (const code of named) {
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    assert.deepEqual(ch.visiblePieces(`a${String.fromCodePoint(code)}b`)[1], { text: `<U+${hex}>`, hidden: true, label: `hidden character U+${hex}` }, `U+${hex}`);
  }
  // Left alone: tab (a diff keeps its indentation), ordinary text, accents, emoji, other scripts and the minus sign.
  assert.equal(ch.visibleText("\tindent\tx"), "\tindent\tx");
  assert.equal(ch.visibleText("café 日本語 😀 −3 → x"), "café 日本語 😀 −3 → x");
  assert.deepEqual(ch.visiblePieces(""), []);
  assert.deepEqual(ch.visiblePieces("plain"), [{ text: "plain", hidden: false, label: null }]);
  // A row's words and tooltip carry the visible form; the raw path stays what the diff request and the row's key use.
  const hostile = file({ path: "docs/report\u202Efdp.exe", oldPath: "docs/old\u0000.txt", status: "renamed" });
  assert.equal(ch.fileRowLabel(hostile), "docs/report<U+202E>fdp.exe, 12 added, 3 removed");
  assert.equal(ch.fileRowTitle(hostile), "docs/old\\x00.txt → docs/report<U+202E>fdp.exe");
  assert.equal(hostile.path, "docs/report\u202Efdp.exe");
  // The line kinds do not depend on the hidden characters (diffLines keeps the raw text; the dialog shows its visible form).
  const kinds = ch.diffLines("diff --git a/x b/x\n@@ -1 +1 @@\n-old \u202E\n+new \u001B[0m\n").map((line) => line.kind);
  assert.deepEqual(kinds, ["meta", "hunk", "del", "add"]);
});

test("an ended session whose read failed is asked again every 30 s while it is shown; a running one keeps its 3 s; one that has an answer is never asked again", () => {
  assert.equal(ch.ENDED_RETRY_MS, 30000);
  const failures = [
    { state: "error", message: "Couldn't reach Agent OS." },
    ok(result({ git: null, files: [], total: 0, at: null })),
    ok(result(), true)
  ];
  for (const source of failures) assert.equal(ch.changesFailed(source), true, JSON.stringify(source));
  for (const source of [{ state: "loading" }, ok(result()), ok(result({ git: false, files: [], total: 0 })), ok(result({ files: [], total: 0 }))]) {
    assert.equal(ch.changesFailed(source), false, JSON.stringify(source));
  }
  assert.equal(ch.changesRetryMs({ status: "exited" }, true), 30000, "ended and failed: try again");
  assert.equal(ch.changesRetryMs({ status: "exited" }, false), null, "ended with an answer: never again");
  for (const status of ["starting", "live", "waiting", "idle", "held"]) assert.equal(ch.changesRetryMs({ status }, true), null, `${status}: the 3 s poll already asks`);
  assert.equal(ch.changesPollMs({ status: "exited" }), null, "the plain poll still never asks for an ended session");
});

test("fix round wiring and styles: the opener row by an explicit ref, the diff parsed once, a named diff box, hunk headers readable, a long title wraps", () => {
  const section = read("src/ui/components/SessionChanges.tsx");
  assert.match(section, /openerPath\.current = file\.path;/, "the clicked row is remembered in a ref, not read from document.activeElement");
  assert.match(section, /el\.dataset\.path === openerPath\.current/, "found by comparing its value, not with a selector string");
  assert.match(section, /data-path=\{file\.path\}/);
  assert.doesNotMatch(section, /document\.activeElement/, "no focus guessing: Safari's WebView does not focus a button on a click");
  assert.match(section, /useInterval\(\(\) => load\(false\), changesRetryMs\(session, failed\)\)/, "an ended session that failed is asked again");
  assert.match(section, /visibilitychange/, "and when the window is shown again");
  assert.match(section, /<VisibleText /);
  const dialog = read("src/ui/components/DiffDialog.tsx");
  assert.match(dialog, /useMemo\(/, "the diff is parsed once per answer, not on every poll");
  assert.match(dialog, /memo\(/, "and its rows are not rebuilt when only the panel's list changed");
  assert.match(dialog, /<pre role="region" className="os-diff" tabIndex=\{0\} aria-labelledby=\{pathId\}>/, "a name the box can really have");
  assert.match(dialog, /<VisibleText /);
  const text = read("src/ui/components/VisibleText.tsx");
  assert.match(text, /visiblePieces\(text\)/);
  assert.doesNotMatch(text, /dangerouslySetInnerHTML/);
  assert.match(read("src/ui/components/AgentConfirmModal.tsx"), /title: ReactNode;/, "the dialog title can hold the visible form of a name");
  const css = read("src/ui/sessions.css");
  const block = css.slice(css.indexOf("/* ---- Files changed and the read-only diff"), css.indexOf("/* ---- end Files changed"));
  assert.match(block, /\.os-diff__line--hunk \{\s*color: var\(--os-accent-strong\);/, "small cobalt text on dark needs the strong accent (7.7:1)");
  assert.match(block, /\.os-modal:has\(\.os-diff-view\) \.os-modal__title \{\s*overflow-wrap: anywhere;/, "a long file name wraps inside the title");
  assert.match(block, /\.os-hidden-char \{[^}]*color: var\(--os-warn\);/, "a visible marker is drawn in a token colour");
});
