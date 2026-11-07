#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md at the repo root: the licence notices of everything that ships inside the
// installers (MIT, and most other licences, ask that the notice travels with the software).
//
//   node scripts/build-notices.mjs           write THIRD_PARTY_NOTICES.md
//   node scripts/build-notices.mjs --check   exit 1 if the committed file is not what this would write
//
// What counts as "shipped":
//   JavaScript  every package in package-lock.json reachable from package.json "dependencies" (the server is
//               bundled into server.mjs by esbuild and the UI by Vite, so the closure is what ends up inside),
//               minus the build-only packages in BUILD_ONLY below and minus optional packages that are only
//               for one platform. node-pty and the @fontsource fonts get their own sections.
//   Rust        the app crate's normal dependencies from `cargo metadata` (not dev, not build), for every
//               platform, so the file does not depend on which computer wrote it.
// Over-including is fine; leaving something out is not.
//
// The output is the same on every operating system: sorted by plain string order, LF line endings, no
// dates, no absolute paths. It needs `npm ci` (the licence files are read from node_modules) and cargo.
// Exit 1 as well when a shipped package has a strong copyleft licence (GPL, AGPL, LGPL without an OR
// alternative) or none at all, unless it is on ALLOWED below.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(root, "THIRD_PARTY_NOTICES.md");
const CARGO_MANIFEST = path.join(root, "desktop", "src-tauri", "Cargo.toml");

// In package.json "dependencies" but only used while building. @vitejs/plugin-react is imported by
// vite.config.ts alone; neither server/ nor src/ imports it, so nothing of it reaches the app.
export const BUILD_ONLY = new Set(["@vitejs/plugin-react"]);

// Packages that may keep a licence the check would refuse. Key: "name" or "name@version"; value: why.
// Empty on purpose: add one only after reading the licence, with the reason.
const ALLOWED = new Map();

const normalise = (text) => text.replace(/\r\n?/g, "\n");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byNameVersion = (a, b) => compare(a.name, b.name) || compare(a.version, b.version);

// ---- JavaScript packages ----------------------------------------------------------------------------

// Where npm would find `name` for the package at `from` ("" is the project): its own node_modules, then
// each folder above.
function resolveDependency(packages, from, name) {
  let base = from;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut === -1 ? "" : base.slice(0, cut);
  }
}

// The shipped npm packages as [{ name, version, key, license }], sorted. `lock` is package-lock.json,
// `pkg` is package.json (both parsed).
export function shippedNpmPackages(lock, pkg) {
  const packages = lock.packages;
  const seen = new Set();
  const queue = Object.keys(pkg.dependencies || {})
    .filter((name) => !BUILD_ONLY.has(name))
    .map((name) => resolveDependency(packages, "", name));
  while (queue.length > 0) {
    const key = queue.pop();
    if (!key || seen.has(key)) continue;
    const entry = packages[key];
    if (entry.dev) continue;
    seen.add(key);
    const wanted = { ...entry.dependencies, ...entry.optionalDependencies };
    for (const [name, meta] of Object.entries(entry.peerDependencies || {})) {
      if (!entry.peerDependenciesMeta?.[name]?.optional) wanted[name] = meta;
    }
    for (const name of Object.keys(wanted)) {
      const child = resolveDependency(packages, key, name);
      if (!child) continue; // an optional package npm did not install
      const childEntry = packages[child];
      if (childEntry.os || childEntry.cpu) continue; // a one-platform binary, not part of the app
      queue.push(child);
    }
  }
  return [...seen]
    .map((key) => ({
      name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
      version: packages[key].version,
      key,
      license: packages[key].license
    }))
    .sort(byNameVersion);
}

// ---- Licence files and checks -----------------------------------------------------------------------

const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicen[cs]e)([-_.].*)?$/i;
const NOT_TEXT = /\.(js|mjs|cjs|ts|json|png|svg|jpg|gif|html|css)$/i;

// The notice files in one package folder: [{ kind: "LICENSE" | "NOTICE", name, text }], sorted by file name.
async function readLicenceFiles(dir, extra = []) {
  const names = new Set(extra);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && LICENCE_FILE.test(entry.name) && !NOT_TEXT.test(entry.name)) names.add(entry.name);
  }
  const files = [];
  for (const name of [...names].sort(compare)) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    files.push({ kind: /^notice/i.test(path.basename(name)) ? "NOTICE" : "LICENSE", name, text: normalise(await readFile(file, "utf8")) });
  }
  return files;
}

// Several licence files for "A OR B" mean the user picks one. Keep the MIT file when there is one (and any
// NOTICE files); otherwise keep them all.
function pickFiles(files, declared) {
  if (!/\sOR\s|\//i.test(declared || "") || files.length < 2) return files;
  const mit = files.filter((file) => file.kind === "LICENSE" && /mit/i.test(file.name));
  if (mit.length === 0) return files;
  return files.filter((file) => file.kind === "NOTICE" || mit.includes(file));
}

// What the declared licence tells us: a plain-words problem, or null when it is fine.
export function licenceProblem(declared) {
  const text = String(declared || "").trim();
  if (!text || /^unlicensed$/i.test(text) || /^see licen[cs]e in/i.test(text)) {
    return `declares no usable licence (${text || "nothing"})`;
  }
  const alternatives = text.replace(/[()]/g, " ").replace(/\//g, " OR ").split(/\s+OR\s+/i);
  const copyleft = (alternative) => alternative.split(/\s+AND\s+/i).some((term) => /^(a|l)?gpl/i.test(term.trim()));
  if (alternatives.every(copyleft)) return `has a strong copyleft licence (${text}) with no alternative`;
  return null;
}

// ---- Rust crates ------------------------------------------------------------------------------------

function cargoMetadata() {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", CARGO_MANIFEST], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`\`cargo metadata\` failed: ${result.error?.message || result.stderr}\nThe notices file needs cargo; install Rust, then run this again.`);
  }
  return JSON.parse(result.stdout);
}

// The crates the app links, from `cargo metadata`: the app's normal dependencies, then theirs.
function shippedCrates(metadata) {
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const rootId = metadata.resolve.root;
  const seen = new Set();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
    }
  }
  seen.delete(rootId);
  return [...seen].map((id) => byId.get(id)).sort(byNameVersion);
}

// ---- Writing the file -------------------------------------------------------------------------------

// Packages that share exactly the same notice text are listed once under one copy of it.
// `items`: [{ name, version, license, files, repository }]. Returns the Markdown for them.
function renderGroups(items) {
  const groups = new Map();
  const missing = [];
  for (const item of items) {
    if (item.files.length === 0) {
      missing.push(item);
      continue;
    }
    const key = JSON.stringify(item.files.map((file) => [file.kind, file.text]));
    if (!groups.has(key)) groups.set(key, { files: item.files, items: [] });
    groups.get(key).items.push(item);
  }
  const out = [];
  for (const group of groups.values()) {
    const licences = [...new Set(group.items.map((item) => item.license || "no licence declared"))].sort(compare);
    out.push(`#### ${licences.join("; ")}`, "", ...group.items.map((item) => `- ${item.name} ${item.version}`), "");
    for (const file of group.files) {
      if (file.kind === "NOTICE") out.push("Notice file:", "");
      else if (group.files.length > 1) out.push("Licence file:", "");
      out.push(...fenced(file.text), "");
    }
  }
  if (missing.length > 0) {
    out.push(
      "#### Packages that ship no licence file",
      "",
      "These packages declare a licence but include no licence text. The licence they declare applies.",
      "",
      ...missing.map((item) => `- ${item.name} ${item.version}: ${item.license}${item.repository ? `, ${item.repository}` : ""}`),
      ""
    );
  }
  return out;
}

// A code fence longer than any run of backticks inside the text.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return [fence + "text", text.replace(/\n+$/, ""), fence];
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return repo ? repo.replace(/^git\+/, "") : "";
}

function allowed(pkg) {
  return ALLOWED.has(pkg.name) || ALLOWED.has(`${pkg.name}@${pkg.version}`);
}

async function npmItems(list, problems) {
  const items = [];
  for (const entry of list) {
    const dir = path.join(root, ...entry.key.split("/"));
    if (!existsSync(path.join(dir, "package.json"))) {
      throw new Error(`${entry.key} is not installed. Run npm ci, then run this again.`);
    }
    const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    const license =
      entry.license ||
      (typeof manifest.license === "string" ? manifest.license : manifest.license?.type) ||
      (Array.isArray(manifest.licenses) ? manifest.licenses.map((l) => l.type).join(" OR ") : "");
    const problem = licenceProblem(license);
    if (problem && !allowed(entry)) problems.push(`${entry.name} ${entry.version} ${problem}`);
    items.push({
      name: entry.name,
      version: entry.version,
      license,
      files: pickFiles(await readLicenceFiles(dir), license),
      repository: repositoryOf(manifest)
    });
  }
  return items;
}

async function crateItems(crates, problems) {
  const items = [];
  for (const crate of crates) {
    const dir = path.dirname(crate.manifest_path);
    const problem = licenceProblem(crate.license);
    if (problem && !allowed(crate)) problems.push(`${crate.name} ${crate.version} ${problem}`);
    items.push({
      name: crate.name,
      version: crate.version,
      license: crate.license || "",
      files: pickFiles(await readLicenceFiles(dir, crate.license_file ? [crate.license_file] : []), crate.license),
      repository: crate.repository || ""
    });
  }
  return items;
}

export async function buildNotices() {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const nodeVersion = (await readFile(path.join(root, "scripts", "fetch-node.mjs"), "utf8")).match(/NODE_VERSION = "([^"]+)"/)[1];
  const problems = [];

  const npm = await npmItems(shippedNpmPackages(lock, pkg), problems);
  const fonts = npm.filter((item) => item.name.startsWith("@fontsource"));
  const nodePty = npm.find((item) => item.name === "node-pty");
  const scripts = npm.filter((item) => !fonts.includes(item) && item !== nodePty);
  const crates = await crateItems(shippedCrates(cargoMetadata()), problems);

  const out = [
    "# Third-party notices",
    "",
    "Agent OS itself is MIT licensed (see [LICENSE](LICENSE)). The app is built from, and ships with, work by many other",
    "people. This file lists that work and carries each licence text, because those licences ask that the notice",
    "travels with the software. It is written by `node scripts/build-notices.mjs`; do not edit it by hand.",
    "",
    "## Bundled programs",
    "",
    `### Node.js ${nodeVersion}`,
    "",
    "The installers carry their own copy of Node.js, so Agent OS does not need Node to be installed. Node.js is open source",
    "(mostly MIT, with the licences of the parts inside it). Its full licence text is the file `LICENSE` in the `node`",
    "folder next to the app's `server` folder, in the installed app's resources.",
    "",
    "### node-pty, conpty.dll and OpenConsole.exe",
    "",
    `node-pty ${nodePty.version} opens the terminals. On Windows it comes with conpty.dll and OpenConsole.exe, from Microsoft's`,
    "terminal project. The licence file below is node-pty's own; its third part is the Microsoft Corporation notice that",
    "covers those two files. The same file is copied beside node-pty's package.json in the app.",
    "",
    ...nodePty.files.flatMap((file) => [...fenced(file.text), ""]),
    "## Fonts",
    "",
    "Archivo and JetBrains Mono are bundled through the @fontsource packages, under the SIL Open Font License 1.1.",
    "",
    ...renderGroups(fonts),
    "## JavaScript packages",
    "",
    "Everything the server and the app window are built from, including what those packages depend on.",
    "",
    ...renderGroups(scripts),
    "## Rust crates",
    "",
    "The libraries inside the desktop shell (the Tauri app), taken from its Cargo.lock for every platform. Where a crate offers",
    "a choice of licences (for example MIT or Apache-2.0), the MIT text is shown.",
    "",
    ...renderGroups(crates)
  ];
  return { text: out.join("\n").replace(/\n+$/, "") + "\n", problems };
}

async function main() {
  const { text, problems } = await buildNotices();
  if (problems.length > 0) {
    console.error("These shipped packages need a decision (read their licence, then add them to ALLOWED in scripts/build-notices.mjs with the reason):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    const current = existsSync(OUTPUT) ? normalise(await readFile(OUTPUT, "utf8")) : "";
    if (current !== text) {
      console.error("THIRD_PARTY_NOTICES.md is out of date. Run `node scripts/build-notices.mjs` and commit the result.");
      process.exit(1);
    }
    console.log("THIRD_PARTY_NOTICES.md is up to date.");
    return;
  }
  await writeFile(OUTPUT, text);
  console.log(`THIRD_PARTY_NOTICES.md written (${text.length} characters).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
