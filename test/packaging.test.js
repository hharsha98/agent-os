// node-pty next to the packaged server (design spec "Dependencies and packaging", planning decision Q21).
// scripts/node-pty-bundle.mjs copies node-pty's lib/, package.json and ONE prebuilt folder next to the
// server bundle, checks each copied binary's CPU from its file header (never by running it: a cross-built
// binary cannot run here), and gives macOS's spawn-helper mode 0755. These tests use made-up headers and
// the real node_modules/node-pty. Nothing is spawned.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { binaryArches, binaryFormat, copyNodePty, parseTargetArgs } from "../scripts/node-pty-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realNodePty = path.join(root, "node_modules", "node-pty");
const isWindows = process.platform === "win32";

// The smallest file headers that say "built for this CPU", written the way each format defines them.
const X64 = 0x01000007;
const ARM64 = 0x0100000c;
function machO(cpu) {
  const b = Buffer.alloc(64);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cpu, 4);
  return b;
}
function universalMachO(cpus) {
  const b = Buffer.alloc(8 + 20 * cpus.length + 32);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, i) => b.writeUInt32BE(cpu, 8 + 20 * i));
  return b;
}
function elf(machine) {
  const b = Buffer.alloc(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  b.writeUInt16LE(machine, 18);
  return b;
}
function pe(machine) {
  const b = Buffer.alloc(256);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  b.writeUInt16LE(machine, 0x84);
  return b;
}

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-packaging-"));
  try {
    return await fn(dir);
  } finally {
    // Retries: on a Windows runner a virus scanner can hold a freshly copied .exe or .dll for a moment.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test("parseTargetArgs: this computer by default, --platform/--arch when given, a clear refusal otherwise", () => {
  const here = { platform: "darwin", arch: "arm64" };
  assert.deepEqual(parseTargetArgs([], here), { platform: "darwin", arch: "arm64" });
  assert.deepEqual(parseTargetArgs(["--skip-node", "--platform", "darwin", "--arch", "x64"], here), { platform: "darwin", arch: "x64" });
  assert.deepEqual(parseTargetArgs(["--arch", "x64", "--platform", "win32"], here), { platform: "win32", arch: "x64" });
  assert.deepEqual(parseTargetArgs(["--platform", "linux"], here), { platform: "linux", arch: "arm64" });
  assert.throws(() => parseTargetArgs(["--platform", "freebsd"], here), /^Error: Unsupported target freebsd\/arm64\. Use darwin\|linux\|win32 with x64\|arm64\.$/);
  assert.throws(() => parseTargetArgs(["--arch", "ia32"], { platform: "win32", arch: "x64" }), /Unsupported target win32\/ia32/);
  assert.throws(() => parseTargetArgs(["--platform"], here), /--platform needs a value/);
  assert.throws(() => parseTargetArgs(["--platform", "--arch", "x64"], here), /--platform needs a value/);
  assert.throws(() => parseTargetArgs([], { platform: "sunos", arch: "x64" }), /Unsupported target sunos\/x64/);
  // A flag spelt with "=" or misspelt must not quietly fall back to this computer's CPU: on an Apple-silicon
  // Mac, `--arch=x64` would otherwise copy the arm64 binaries into an Intel app.
  assert.throws(() => parseTargetArgs(["--arch=x64"], here), /^Error: Unknown option --arch=x64\. Use --platform <p> --arch <a> \(a space, not =\)\.$/);
  assert.throws(() => parseTargetArgs(["--platform=darwin"], here), /^Error: Unknown option --platform=darwin\. Use --platform <p> --arch <a> \(a space, not =\)\.$/);
  assert.throws(() => parseTargetArgs(["--platforms", "darwin"], here), /^Error: Unknown option --platforms\. Use --platform <p> --arch <a> \(a space, not =\)\.$/);
  assert.throws(() => parseTargetArgs(["--skip-node", "--platform", "darwin", "--architecture", "x64"], here), /Unknown option --architecture\./);
});

test("binaryArches reads the CPU from Mach-O, universal Mach-O, ELF and PE headers, and nothing else", () => {
  assert.deepEqual(binaryArches(machO(X64)), ["x64"]);
  assert.deepEqual(binaryArches(machO(ARM64)), ["arm64"]);
  assert.deepEqual(binaryArches(universalMachO([X64, ARM64])), ["x64", "arm64"]);
  assert.deepEqual(binaryArches(elf(62)), ["x64"]);
  assert.deepEqual(binaryArches(elf(183)), ["arm64"]);
  assert.deepEqual(binaryArches(pe(0x8664)), ["x64"]);
  assert.deepEqual(binaryArches(pe(0xaa64)), ["arm64"]);
  // A shell script, 32-bit Intel binaries of each kind, cut-off files, and empty input: no CPU we ship for.
  for (const other of [Buffer.alloc(0), Buffer.from("#!/bin/sh\necho hi\n"), machO(0x7), elf(3), pe(0x14c), Buffer.from("MZ"), Buffer.from([0x7f, 0x45, 0x4c, 0x46])]) {
    assert.deepEqual(binaryArches(other), []);
  }
});

test("binaryFormat tells Mach-O (also universal), ELF and PE apart, whatever their CPU, and nothing else", () => {
  assert.equal(binaryFormat(machO(X64)), "macho");
  assert.equal(binaryFormat(machO(ARM64)), "macho");
  assert.equal(binaryFormat(universalMachO([X64, ARM64])), "macho");
  assert.equal(binaryFormat(elf(62)), "elf");
  assert.equal(binaryFormat(elf(183)), "elf");
  assert.equal(binaryFormat(elf(3)), "elf", "a 32-bit Intel ELF is still an ELF file");
  assert.equal(binaryFormat(pe(0x8664)), "pe");
  assert.equal(binaryFormat(pe(0xaa64)), "pe");
  // A shell script, cut-off files, an "MZ" file with no PE header, and empty input are none of the three.
  const dosOnly = Buffer.alloc(256);
  dosOnly.write("MZ", 0, "latin1");
  for (const other of [Buffer.alloc(0), Buffer.from("#!/bin/sh\necho hi\n"), Buffer.from("MZ"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), dosOnly]) {
    assert.equal(binaryFormat(other), null);
  }
});

test("node-pty ships a prebuilt binary for every computer the app and the Docker image are built for, each for the CPU its folder names", async () => {
  const pkg = JSON.parse(await readFile(path.join(realNodePty, "package.json"), "utf8"));
  assert.equal(pkg.version, "1.2.0-beta.14", "the approved exact pin");
  const required = { darwin: ["pty.node", "spawn-helper"], linux: ["pty.node"], win32: ["conpty.node", "conpty_console_list.node"] };
  // The four release installers, plus linux-arm64 for the Docker image on an Apple-silicon Mac:
  // with a prebuilt binary, `npm ci` in node:20-bookworm-slim (no compiler) never runs node-gyp.
  for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
    const [platform, arch] = target.split("-");
    for (const name of required[platform]) {
      const file = path.join(realNodePty, "prebuilds", target, name);
      assert.ok(existsSync(file), `${target}/${name} is in the package`);
      assert.ok(binaryArches(await readFile(file)).includes(arch), `${target}/${name} is built for ${arch}`);
    }
  }
});

test("copyNodePty copies lib, package.json and only the target's prebuild, with no debug symbols, for each release installer", async () => {
  await withTemp(async (tmp) => {
    for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["win32", "x64"]]) {
      const prebuild = `${platform}-${arch}`;
      const to = path.join(tmp, prebuild, "node_modules", "node-pty");
      const result = await copyNodePty({ from: realNodePty, to, platform, arch });
      assert.equal(result.prebuild, prebuild);
      assert.ok(result.files.includes("package.json"));
      assert.ok(result.files.includes("lib/index.js"));
      assert.ok(result.files.includes("lib/worker/conoutSocketWorker.js"), "the Windows output worker comes with lib/");
      assert.deepEqual(await readdir(path.join(to, "prebuilds")), [prebuild], "only the target's prebuild");
      assert.ok(!result.files.some((file) => file.endsWith(".pdb") || file.endsWith(".map")), "no debug symbols or source maps");
      for (const absent of ["build", "src", "third_party", "scripts", "binding.gyp"]) assert.ok(!existsSync(path.join(to, absent)), `${absent} is not copied`);
      assert.ok(result.bytes > 0 && result.bytes < 3 * 1024 * 1024, `${prebuild}: ${result.bytes} bytes`);
      if (platform === "darwin" && !isWindows) {
        assert.equal((await stat(path.join(to, "prebuilds", prebuild, "spawn-helper"))).mode & 0o777, 0o755, "spawn-helper can be run");
      }
      if (platform === "win32") {
        assert.ok(result.files.includes(`prebuilds/${prebuild}/conpty.node`));
        assert.ok(result.files.includes(`prebuilds/${prebuild}/conpty_console_list.node`));
      }
    }
  });
});

test("copyNodePty stops with a plain sentence: node-pty missing, no prebuild for the target, a helper missing, or a binary for another CPU", async () => {
  await withTemp(async (tmp) => {
    const fake = path.join(tmp, "fake-node-pty");
    const prebuilt = path.join(fake, "prebuilds", "darwin-x64");
    await mkdir(path.join(fake, "lib"), { recursive: true });
    await mkdir(prebuilt, { recursive: true });
    await writeFile(path.join(fake, "package.json"), JSON.stringify({ name: "node-pty", main: "./lib/index.js" }));
    await writeFile(path.join(fake, "lib", "index.js"), "module.exports = {};\n");
    await writeFile(path.join(prebuilt, "pty.node"), machO(ARM64)); // the wrong CPU, on purpose
    await writeFile(path.join(prebuilt, "spawn-helper"), machO(X64));

    await assert.rejects(
      copyNodePty({ from: path.join(tmp, "nothing-here"), to: path.join(tmp, "out0"), platform: "darwin", arch: "arm64" }),
      /node-pty is not installed/
    );
    await assert.rejects(
      copyNodePty({ from: fake, to: path.join(tmp, "out1"), platform: "linux", arch: "x64" }),
      /node-pty has no prebuilt binary for linux-x64/
    );
    await assert.rejects(
      copyNodePty({ from: fake, to: path.join(tmp, "out2"), platform: "darwin", arch: "x64" }),
      /prebuilds\/darwin-x64\/pty\.node is built for arm64, not x64\./
    );
    await writeFile(path.join(prebuilt, "pty.node"), machO(X64));
    await rm(path.join(prebuilt, "spawn-helper"));
    await assert.rejects(
      copyNodePty({ from: fake, to: path.join(tmp, "out3"), platform: "darwin", arch: "x64" }),
      /node-pty's darwin-x64 prebuild has no spawn-helper\./
    );
    // With both files right, it copies, and spawn-helper becomes runnable.
    await writeFile(path.join(prebuilt, "spawn-helper"), machO(X64));
    const done = await copyNodePty({ from: fake, to: path.join(tmp, "out4"), platform: "darwin", arch: "x64" });
    assert.deepEqual(done.files, ["lib/index.js", "package.json", "prebuilds/darwin-x64/pty.node", "prebuilds/darwin-x64/spawn-helper"]);
    if (!isWindows) assert.equal((await stat(path.join(tmp, "out4", "prebuilds", "darwin-x64", "spawn-helper"))).mode & 0o777, 0o755);
  });
});

test("copyNodePty stops with a plain sentence when a binary is the wrong kind of file for the target system, even with the right CPU", async () => {
  await withTemp(async (tmp) => {
    // One made-up node-pty with a prebuild folder for each system; each test below swaps one file.
    const fake = path.join(tmp, "fake-node-pty");
    await mkdir(path.join(fake, "lib"), { recursive: true });
    await writeFile(path.join(fake, "package.json"), JSON.stringify({ name: "node-pty", main: "./lib/index.js" }));
    await writeFile(path.join(fake, "lib", "index.js"), "module.exports = {};\n");
    const right = { darwin: machO(X64), linux: elf(62), win32: pe(0x8664) };
    const folders = { darwin: ["pty.node", "spawn-helper"], linux: ["pty.node"], win32: ["conpty.node", "conpty_console_list.node"] };
    for (const [platform, names] of Object.entries(folders)) {
      await mkdir(path.join(fake, "prebuilds", `${platform}-x64`), { recursive: true });
      for (const name of names) await writeFile(path.join(fake, "prebuilds", `${platform}-x64`, name), right[platform]);
    }
    const copy = (platform, out) => copyNodePty({ from: fake, to: path.join(tmp, out), platform, arch: "x64" });
    const put = (platform, name, buffer) => writeFile(path.join(fake, "prebuilds", `${platform}-x64`, name), buffer);

    // Each system's own kind of file copies.
    for (const platform of ["darwin", "linux", "win32"]) assert.ok((await copy(platform, `ok-${platform}`)).files.length > 0, platform);

    // The right CPU (x64) in the wrong kind of file: a Linux file in the macOS app, and so on.
    await put("darwin", "pty.node", elf(62));
    await assert.rejects(copy("darwin", "bad1"), /^Error: prebuilds\/darwin-x64\/pty\.node is a Linux \(ELF\) file, not a macOS \(Mach-O\) one\.$/);
    await put("darwin", "pty.node", right.darwin);
    await put("darwin", "spawn-helper", pe(0x8664));
    await assert.rejects(copy("darwin", "bad2"), /^Error: prebuilds\/darwin-x64\/spawn-helper is a Windows \(PE\) file, not a macOS \(Mach-O\) one\.$/);
    await put("darwin", "spawn-helper", right.darwin);
    await put("linux", "pty.node", machO(X64));
    await assert.rejects(copy("linux", "bad3"), /^Error: prebuilds\/linux-x64\/pty\.node is a macOS \(Mach-O\) file, not a Linux \(ELF\) one\.$/);
    await put("linux", "pty.node", right.linux);
    await put("win32", "conpty.node", elf(62));
    await assert.rejects(copy("win32", "bad4"), /^Error: prebuilds\/win32-x64\/conpty\.node is a Linux \(ELF\) file, not a Windows \(PE\) one\.$/);
    await put("win32", "conpty.node", right.win32);
    // A universal Mach-O is a Mach-O file, so it passes the kind check (and then the CPU check).
    await put("darwin", "pty.node", universalMachO([X64, ARM64]));
    assert.ok((await copy("darwin", "ok-universal")).files.includes("prebuilds/darwin-x64/pty.node"));
    await put("darwin", "pty.node", right.darwin);

    // Not any binary at all (a script, or a cut-off file): said plainly, not as "an unknown CPU".
    await put("linux", "pty.node", Buffer.from("#!/bin/sh\necho hi\n"));
    await assert.rejects(copy("linux", "bad5"), /^Error: prebuilds\/linux-x64\/pty\.node is not a Linux \(ELF\) file\.$/);
    await put("linux", "pty.node", right.linux);
    await put("win32", "conpty_console_list.node", Buffer.from("MZ"));
    await assert.rejects(copy("win32", "bad6"), /^Error: prebuilds\/win32-x64\/conpty_console_list\.node is not a Windows \(PE\) file\.$/);
    await put("win32", "conpty_console_list.node", right.win32);

    // The CPU check still comes after, with its own sentence.
    await put("linux", "pty.node", elf(183));
    await assert.rejects(copy("linux", "bad7"), /^Error: prebuilds\/linux-x64\/pty\.node is built for arm64, not x64\.$/);
  });
});

test("the build scripts keep node-pty outside server.mjs, copy it for the target, and do so before --skip-node returns", async () => {
  const bundle = await readFile(path.join(root, "scripts", "build-server-bundle.mjs"), "utf8");
  assert.match(bundle, /external: \["@elizaos\/core", "node-pty"\]/);
  // ws's optional bufferutil and utf-8-validate are NOT external: left external, ws's require() would search
  // every folder above the installed app and load a native module found there. They resolve to a module
  // that throws, and ws's try/catch uses its plain-JavaScript code.
  assert.doesNotMatch(bundle, /external:[^\]]*(bufferutil|utf-8-validate)/);
  assert.match(bundle, /filter: \/\^\(bufferutil\|utf-8-validate\)\$\//);
  assert.match(bundle, /throw new Error\("not bundled"\)/);
  assert.match(bundle, /parseTargetArgs\(process\.argv\.slice\(2\)\)/);
  assert.match(bundle, /copyNodePty\(\{/);
  const prepare = await readFile(path.join(root, "scripts", "prepare-desktop.mjs"), "utf8");
  const skipAt = prepare.indexOf('process.argv.includes("--skip-node")');
  assert.ok(skipAt > 0, "prepare-desktop.mjs still has --skip-node");
  const bundleAt = prepare.indexOf('"build:server-bundle", "--", "--platform", target.platform, "--arch", target.arch');
  const copyAt = prepare.indexOf('cp(path.join(root, "build", "server"), server');
  assert.ok(bundleAt > 0 && bundleAt < skipAt, "the bundle is built for the target before --skip-node returns");
  assert.ok(copyAt > 0 && copyAt < skipAt, "the bundle reaches resources/server before --skip-node returns (the release always passes it)");
});

// The bundle tests in test/portable.test.js, read as text (nothing is run): the rules that keep them from
// leaving temp folders behind or failing for the wrong reason on a developer's or a Windows machine.
test("the bundled-server tests retry their cleanups, use real-path temp folders, and start the server inside their try", async () => {
  const source = await readFile(path.join(root, "test", "portable.test.js"), "utf8");
  const start = source.indexOf('describe("bundled server runs outside the repo"');
  const end = source.indexOf('test("which(');
  assert.ok(start > 0 && end > start, "found the bundled-server block");
  const block = source.slice(start, end);
  const count = (text, pattern) => (text.match(pattern) || []).length;
  // A Windows virus scanner can hold a freshly copied .exe or .dll for a moment: every rm() retries.
  const removals = count(block, /\brm\(/g);
  assert.ok(removals >= 1, "the block removes folders");
  assert.equal(count(block, /\brm\([^;]*maxRetries: 5, retryDelay: 200/g), removals, "every rm() in the block has maxRetries: 5, retryDelay: 200");
  // The temp HOME and server folders are real paths (macOS: /var is /private/var), like every other test's.
  const temps = count(block, /\bmkdtemp\(/g);
  assert.ok(temps >= 1, "the block makes temp folders");
  assert.equal(count(block, /realpath\(await mkdtemp\(/g), temps, "every mkdtemp() is wrapped in realpath()");
  // startBundle comes after `try {`, so the finally clause always cleans up, even when starting fails.
  const bodies = block.split(/\n  test\(/).slice(1);
  const starting = bodies.filter((body) => body.includes("await startBundle("));
  assert.ok(starting.length >= 3, "the bundle tests that start a server");
  for (const body of starting) {
    assert.ok(body.indexOf("try {") > 0 && body.indexOf("try {") < body.indexOf("await startBundle("), "startBundle is called inside try:\n" + body.slice(0, 120));
  }
});
