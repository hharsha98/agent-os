// node-pty next to the packaged server (design spec "Dependencies and packaging", planning decision Q21).
//
// esbuild cannot put a native module inside server.mjs, so scripts/build-server-bundle.mjs keeps
// "node-pty" external and calls copyNodePty() to put the package next to the bundle, in
// build/server/node_modules/node-pty/, where Node finds it from server.mjs. Only what node-pty needs at
// run time is copied: lib/, package.json, and ONE prebuilt folder, prebuilds/<platform>-<arch>, for the
// computer the app will run on. That can differ from this computer: the release workflow builds the
// Intel Mac app on an Apple-silicon runner.
//
// The copied binaries are never run (a cross-built one could not run here). Each one's file header is
// read instead, to check it was built for the target's CPU, and macOS's spawn-helper (the small program
// node-pty starts for every terminal) gets mode 0755.
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

export const TARGET_PLATFORMS = ["darwin", "linux", "win32"];
export const TARGET_ARCHES = ["x64", "arm64"];

// What node-pty 1.2 loads at run time, per system: lib/utils.js loadNativeModule() looks in build/Release,
// build/Debug, then prebuilds/<platform>-<arch>; lib/unixTerminal.js starts <that folder>/spawn-helper on
// macOS; on Windows lib/windowsPtyAgent.js loads conpty.node and conpty_console_list.node.
const REQUIRED = {
  darwin: ["pty.node", "spawn-helper"],
  linux: ["pty.node"],
  win32: ["conpty.node", "conpty_console_list.node"]
};

// The target computer: this one, unless --platform and/or --arch name another. Same names as
// scripts/fetch-node.mjs (Node's process.platform and process.arch).
export function parseTargetArgs(argv, { platform = process.platform, arch = process.arch } = {}) {
  const target = { platform, arch };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== "--platform" && flag !== "--arch") {
      // `--arch=x64` or a misspelt `--platforms` must not quietly fall back to this computer's CPU.
      if (flag.startsWith("--platform") || flag.startsWith("--arch")) {
        throw new Error(`Unknown option ${flag}. Use --platform <p> --arch <a> (a space, not =).`);
      }
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} needs a value, for example ${flag === "--platform" ? "--platform darwin" : "--arch x64"}.`);
    }
    target[flag === "--platform" ? "platform" : "arch"] = value;
    i += 1;
  }
  if (!TARGET_PLATFORMS.includes(target.platform) || !TARGET_ARCHES.includes(target.arch)) {
    throw new Error(`Unsupported target ${target.platform}/${target.arch}. Use darwin|linux|win32 with x64|arm64.`);
  }
  return target;
}

// The CPUs a binary was built for, read from its header; [] when it is not a 64-bit Mach-O, universal
// Mach-O, ELF or PE file for x64 or arm64.
//   Mach-O (64-bit): magic 0xfeedfacf, stored little-endian; the CPU type is at byte 4.
//   Universal Mach-O: magic 0xcafebabe (0xcafebabf with 64-bit entries), big-endian; the number of
//     entries is at byte 4, then one entry per CPU (20 or 32 bytes) whose first field is its CPU type.
//   ELF: 0x7f "ELF"; byte 5 is the byte order (1 little, 2 big); the machine is 2 bytes at byte 18.
//   PE (Windows .node, .dll, .exe): "MZ"; the PE header's offset is at byte 0x3c, where "PE\0\0" is
//     followed by the machine, 2 bytes, little-endian.
const MACHO_CPU = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"]
]);
const ELF_MACHINE = new Map([
  [62, "x64"],
  [183, "arm64"]
]);
const PE_MACHINE = new Map([
  [0x8664, "x64"],
  [0xaa64, "arm64"]
]);

export function binaryArches(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return [];
  if (buffer.readUInt32LE(0) === 0xfeedfacf) {
    const arch = MACHO_CPU.get(buffer.readUInt32LE(4));
    return arch ? [arch] : [];
  }
  const universal = buffer.readUInt32BE(0);
  if (universal === 0xcafebabe || universal === 0xcafebabf) {
    const entry = universal === 0xcafebabe ? 20 : 32;
    const count = buffer.readUInt32BE(4);
    const arches = [];
    for (let i = 0; i < count && 8 + (i + 1) * entry <= buffer.length; i += 1) {
      const arch = MACHO_CPU.get(buffer.readUInt32BE(8 + i * entry));
      if (arch && !arches.includes(arch)) arches.push(arch);
    }
    return arches;
  }
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    if (buffer.length < 20) return [];
    const machine = buffer[5] === 2 ? buffer.readUInt16BE(18) : buffer.readUInt16LE(18);
    const arch = ELF_MACHINE.get(machine);
    return arch ? [arch] : [];
  }
  if (buffer[0] === 0x4d && buffer[1] === 0x5a && buffer.length >= 0x40) {
    const offset = buffer.readUInt32LE(0x3c);
    if (offset + 6 > buffer.length || buffer.readUInt32LE(offset) !== 0x00004550) return [];
    const arch = PE_MACHINE.get(buffer.readUInt16LE(offset + 4));
    return arch ? [arch] : [];
  }
  return [];
}

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files.sort();
}

const withSlashes = (relative) => relative.split(path.sep).join("/");

// Copies node-pty from `from` (normally node_modules/node-pty) to `to` for one target computer.
// Returns { prebuild, files, bytes }: `files` are relative to `to`, with "/" separators, sorted.
// Throws, with a plain sentence, when node-pty is missing, has no prebuilt binary for the target, misses a
// file it needs there, or a copied binary was built for another CPU.
export async function copyNodePty({ from, to, platform, arch }) {
  const prebuild = `${platform}-${arch}`;
  if (!existsSync(path.join(from, "package.json")) || !existsSync(path.join(from, "lib"))) {
    throw new Error(`node-pty is not installed (nothing at ${from}). Run npm ci first, then build again.`);
  }
  const source = path.join(from, "prebuilds", prebuild);
  if (!existsSync(source)) {
    throw new Error(
      `node-pty has no prebuilt binary for ${prebuild} (looked in ${source}). Sessions could not start in that app, so the build stops here.`
    );
  }
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  await cp(path.join(from, "package.json"), path.join(to, "package.json"));
  await cp(path.join(from, "lib"), path.join(to, "lib"), {
    recursive: true,
    filter: (file) => !file.endsWith(".map") && !file.endsWith(".test.js")
  });
  const target = path.join(to, "prebuilds", prebuild);
  // Debug symbols (.pdb, about 10 MB on Windows) are not needed to run.
  await cp(source, target, { recursive: true, filter: (file) => !file.endsWith(".pdb") });

  for (const name of REQUIRED[platform]) {
    if (!existsSync(path.join(target, name))) throw new Error(`node-pty's ${prebuild} prebuild has no ${name}.`);
  }
  for (const file of await listFiles(target)) {
    if (!/\.(node|dll|exe)$/.test(file) && path.basename(file) !== "spawn-helper") continue;
    const arches = binaryArches(await readFile(file));
    if (!arches.includes(arch)) {
      const built = arches.length > 0 ? arches.join(" and ") : "an unknown CPU";
      throw new Error(`${withSlashes(path.relative(to, file))} is built for ${built}, not ${arch}.`);
    }
  }
  if (platform === "darwin") {
    // node-pty starts spawn-helper for every terminal, so it must be runnable. Set the mode, then check it
    // (a Windows computer has no such mode bits, so it cannot check).
    const helper = path.join(target, "spawn-helper");
    await chmod(helper, 0o755);
    if (process.platform !== "win32") {
      const mode = (await stat(helper)).mode & 0o777;
      if (mode !== 0o755) throw new Error(`spawn-helper has mode ${mode.toString(8)}, not 755.`);
    }
  }
  const files = await listFiles(to);
  let bytes = 0;
  for (const file of files) bytes += (await stat(file)).size;
  return { prebuild, files: files.map((file) => withSlashes(path.relative(to, file))), bytes };
}
