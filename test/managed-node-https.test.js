// server/runtime/setup/managed-node.js: a Node download that ends at an address that is not https is refused
// (review: the final address after redirects counts), and the local test mirror still works.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Readable } from "node:stream";

import { assertSecureFinalUrl, ensureManagedNode } from "../server/runtime/setup/managed-node.js";

test("assertSecureFinalUrl: https passes; http and other schemes are refused; the 127.0.0.1 mirror passes only when it answered itself", () => {
  assert.doesNotThrow(() => assertSecureFinalUrl({ url: "https://nodejs.org/dist/x.tar.gz" }, "https://nodejs.org/dist/x.tar.gz"));
  // A redirect from https to http, or to a made-up scheme, is refused.
  assert.throws(() => assertSecureFinalUrl({ url: "http://nodejs.org/dist/x.tar.gz" }, "https://nodejs.org/dist/x.tar.gz"), /not https/);
  assert.throws(() => assertSecureFinalUrl({ url: "ftp://nodejs.org/x" }, "https://nodejs.org/dist/x.tar.gz"), /not https/);
  // The test mirror: plain http, same address as asked.
  assert.doesNotThrow(() => assertSecureFinalUrl({ url: "http://127.0.0.1:5555/nodejs.org/x" }, "http://127.0.0.1:5555/nodejs.org/x"));
  // ...but not when it sent us somewhere else, or to another port.
  assert.throws(() => assertSecureFinalUrl({ url: "http://evil.example/x" }, "http://127.0.0.1:5555/nodejs.org/x"), /not https/);
  assert.throws(() => assertSecureFinalUrl({ url: "http://127.0.0.1:6666/x" }, "http://127.0.0.1:5555/nodejs.org/x"), /not https/);
  // An http address that is not the mirror was never allowed to start with.
  assert.throws(() => assertSecureFinalUrl({ url: "http://nodejs.org/x" }, "http://nodejs.org/x"), /not https/);
  // A response with no address of its own is judged by the address that was asked for.
  assert.doesNotThrow(() => assertSecureFinalUrl({}, "https://nodejs.org/x"));
  assert.throws(() => assertSecureFinalUrl({}, "http://nodejs.org/x"), /not https/);
});

test("ensureManagedNode refuses an archive whose download was redirected to a plain http address", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-os-managed-https-"));
  const savedRoot = process.env.AGENT_OS_MANAGED_ROOT;
  const savedMirror = process.env.AGENT_OS_SETUP_MIRROR;
  const savedFetch = globalThis.fetch;
  try {
    process.env.AGENT_OS_MANAGED_ROOT = root;
    delete process.env.AGENT_OS_SETUP_MIRROR;
    const osName = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform];
    const ext = { darwin: "tar.gz", linux: "tar.xz", win32: "zip" }[process.platform];
    const archName = process.arch === "arm64" ? "arm64" : "x64";
    const filename = `node-v24.99.0-${osName}-${archName}.${ext}`;
    const body = Buffer.from("not a real archive");
    const shasums = `${crypto.createHash("sha256").update(body).digest("hex")}  ${filename}\n`;
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      if (String(url).endsWith("SHASUMS256.txt")) {
        return { ok: true, status: 200, url: String(url), text: async () => shasums };
      }
      // The archive request ends somewhere that is not https.
      return { ok: true, status: 200, url: `http://evil.example/${filename}`, body: Readable.toWeb(Readable.from([body])) };
    };
    await assert.rejects(ensureManagedNode({ accepts: () => false }), /not https/);
    assert.equal(asked.length, 2, "it asked for the list and then the archive, and went no further");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedRoot === undefined) delete process.env.AGENT_OS_MANAGED_ROOT;
    else process.env.AGENT_OS_MANAGED_ROOT = savedRoot;
    if (savedMirror !== undefined) process.env.AGENT_OS_SETUP_MIRROR = savedMirror;
    await rm(root, { recursive: true, force: true });
  }
});
