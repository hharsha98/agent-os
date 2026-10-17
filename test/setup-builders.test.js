// One-click install and sign-in for the coding agents (Claude Code, Codex,
// Cursor CLI): recipes, the plan per operating system, install jobs (against a
// local http mirror standing in for the official hosts), the sign-in module and
// its HTTP routes. Every test uses a temp HOME/USERPROFILE/AGENT_OS_HOME, a PATH
// of fake shims plus the system folders, and fake CLIs -- nothing here may start
// a real Claude Code, Codex or Cursor, install anything for real, or open a
// real browser or Terminal. Anything that spawns a fake (a shebang script) is
// POSIX-only, matching test/setup.test.js.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ADAPTERS } from "../server/runtime/agents/index.js";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { getRunManager } from "../server/runtime/runs/run-manager.js";
import { applyMirror, getInstallRecipe } from "../server/runtime/setup/recipes.js";
import { buildSetupPlan } from "../server/runtime/setup/plan.js";
import { cancelSetupJob, getSetupJob, resetSetupJobsForTest, retrySetupJob, startSetupJob } from "../server/runtime/setup/jobs.js";
import { readReceipt } from "../server/runtime/setup/receipt.js";
import {
  cancelSignIn,
  interpretStatus,
  latestRunSummary,
  loginCommandLine,
  openSignInInTerminal,
  resetSignInForTest,
  signInStatus,
  startSignIn
} from "../server/runtime/setup/signin.js";
import { clearSystemCheckCache, systemCheck } from "../server/runtime/setup/system-check.js";
import { FAKE_LOGIN_SHELL } from "./helpers/fake-agents.js";
import { installFakeAgent as installFakeAgentAt, shimText, writeFakeAgentCli } from "./helpers/fake-builder-clis.js";
// The file-access spy lives with the other plan-brains Safety checks (Task B1a); it is the same code.
import { FORBIDDEN_PATH, spyOnFileAccess } from "./helpers/plan-brains-safety.js";

const isWindows = process.platform === "win32";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posixSkip = { skip: isWindows ? "spawns shebang fake CLIs via a local mirror (POSIX-only)" : false };
const CODING = ["claude", "codex", "cursor"];

// ---- fake CLIs -----------------------------------------------------------------
// One script plays all three agents (test/helpers/fake-builder-clis.js; its first
// argument says which). It writes every call to $HOME/.fake-agent-calls.log, so a
// test can prove that only --version, --help, status and login were ever run.

// The official installers, as fake bash scripts. Each one logs that it ran, so
// a test can prove an installer was (or was not) ever started.
function buildFakeInstaller(kind, jsPath) {
  const shims = kind === "cursor" ? ["agent", "cursor-agent"] : ["claude"];
  const writeShims = shims
    .map((name) => `cat > "$HOME/.local/bin/${name}" <<'SHIM'\n${shimText(jsPath, kind).trimEnd()}\nSHIM\nchmod +x "$HOME/.local/bin/${name}"`)
    .join("\n");
  return `#!/bin/bash
set -u
echo "installer-run ${kind} args=$*" >> "$HOME/.fake-installer-runs.log"
echo "Downloading ${kind} ..."
mkdir -p "$HOME/.local/bin"

if [ -f "$HOME/.fake-${kind}-sleep" ]; then
  sleep 300 &
  echo $! > "$HOME/.fake-sleep-pid"
  wait
  exit 0
fi

if [ -f "$HOME/.fake-${kind}-fail-once" ] && [ ! -f "$HOME/.fake-${kind}-failed-once" ]; then
  touch "$HOME/.fake-${kind}-failed-once"
  echo "curl: (6) Could not resolve host: downloads.example" >&2
  exit 1
fi

${writeShims}

if [ -f "$HOME/.fake-${kind}-partial" ] && [ ! -f "$HOME/.fake-${kind}-partial-done" ]; then
  touch "$HOME/.fake-${kind}-partial-done"
  echo "Setup finished late and then failed" >&2
  exit 1
fi

echo "${kind} installed"
exit 0
`;
}

// A fake npm that only accepts exactly `install -g @openai/codex --prefix <dir>`
// and leaves a codex launcher in <dir>/bin, as the real one would.
function buildFakeNpm(jsPath) {
  return `#!/bin/sh
echo "npm $*" >> "$HOME/.fake-npm-args.log"
echo "PATH_SEEN=$PATH" >> "$HOME/.fake-npm-path.log"
if [ "$1" != "install" ] || [ "$2" != "-g" ] || [ "$3" != "@openai/codex" ] || [ "$4" != "--prefix" ]; then
  echo "unexpected npm arguments: $*" >&2
  exit 2
fi
if [ -f "$HOME/.fake-npm-fail" ]; then
  echo "npm ERR! code ENOTFOUND" >&2
  echo "npm ERR! network request failed" >&2
  exit 1
fi
mkdir -p "$5/bin"
cat > "$5/bin/codex" <<'SHIM'
#!/bin/sh
exec "${process.execPath}" "${jsPath}" codex "$@"
SHIM
chmod +x "$5/bin/codex"
echo "added 1 package"
exit 0
`;
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---- shared fixtures: fake CLIs, fake Node releases, a local mirror -------------
let sourceDir = null;
let agentJsPath = "";
let oldNodeDir = null; // a fake Node 20: too old for Codex
let node22Dir = null; // a fake Node 22 with a fake npm: good enough for Codex
let fakeOpenDir = null; // a fake `open`, so a test can never open a real Terminal
let mirrorServer = null;
let mirrorPort = 0;
let mirrorHits = {};
const mirrorState = { scripts: {}, nodeShasums: "", nodeTarballName: "", nodeTarballBuffer: Buffer.alloc(0) };

before(async () => {
  if (isWindows) return;
  sourceDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-src-"));
  agentJsPath = await writeFakeAgentCli(sourceDir);
  const npmText = buildFakeNpm(agentJsPath);

  oldNodeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-oldnode-"));
  await writeFile(path.join(oldNodeDir, "node"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v20.1.0"; exit 0; fi\nexit 1\n`);
  await chmod(path.join(oldNodeDir, "node"), 0o755);

  node22Dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-node22-"));
  await writeFile(path.join(node22Dir, "node"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v22.5.0"; exit 0; fi\nexit 1\n`);
  await chmod(path.join(node22Dir, "node"), 0o755);
  await writeFile(path.join(node22Dir, "npm"), npmText);
  await chmod(path.join(node22Dir, "npm"), 0o755);

  fakeOpenDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-open-"));
  await writeFile(path.join(fakeOpenDir, "open"), `#!/bin/sh\necho "$@" >> "$HOME/.fake-open-calls.log"\nexit 0\n`);
  await chmod(path.join(fakeOpenDir, "open"), 0o755);

  // A fake Node 24 release for this exact platform/arch, with a node that
  // reports its version and an npm, so the real tar/extract path runs.
  const archName = process.arch === "arm64" ? "arm64" : "x64";
  const osName = process.platform === "darwin" ? "darwin" : "linux";
  const ext = process.platform === "darwin" ? "tar.gz" : "tar.xz";
  const dirName = `node-v24.99.0-${osName}-${archName}`;
  const stageDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-nodepkg-"));
  const binDir = path.join(stageDir, dirName, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "node"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v24.99.0"; exit 0; fi\necho fake-managed-node\n`);
  await writeFile(path.join(binDir, "npm"), npmText);
  await chmod(path.join(binDir, "node"), 0o755);
  await chmod(path.join(binDir, "npm"), 0o755);
  const tarballName = `${dirName}.${ext}`;
  const tarballPath = path.join(stageDir, tarballName);
  const tarResult = spawnSync("tar", [ext === "tar.gz" ? "-czf" : "-cJf", tarballPath, "-C", stageDir, dirName]);
  if (tarResult.status !== 0) throw new Error(`failed to build the fake node tarball: ${tarResult.stderr}`);
  const tarballBuffer = await readFile(tarballPath);
  await rm(stageDir, { recursive: true, force: true });
  mirrorState.nodeShasums = `${crypto.createHash("sha256").update(tarballBuffer).digest("hex")}  ${tarballName}\n`;
  mirrorState.nodeTarballName = tarballName;
  mirrorState.nodeTarballBuffer = tarballBuffer;

  mirrorState.scripts["/claude.ai/install.sh"] = buildFakeInstaller("claude", agentJsPath);
  mirrorState.scripts["/cursor.com/install"] = buildFakeInstaller("cursor", agentJsPath);

  mirrorServer = http.createServer((req, res) => {
    mirrorHits[req.url] = (mirrorHits[req.url] || 0) + 1;
    if (mirrorState.scripts[req.url]) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(mirrorState.scripts[req.url]);
      return;
    }
    if (req.url === "/nodejs.org/dist/latest-v24.x/SHASUMS256.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(mirrorState.nodeShasums);
      return;
    }
    if (req.url === `/nodejs.org/dist/latest-v24.x/${mirrorState.nodeTarballName}`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(mirrorState.nodeTarballBuffer);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => mirrorServer.listen(0, "127.0.0.1", resolve));
  mirrorPort = mirrorServer.address().port;
});

after(async () => {
  if (mirrorServer) await new Promise((resolve) => mirrorServer.close(resolve));
  for (const dir of [sourceDir, oldNodeDir, node22Dir, fakeOpenDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Full isolation for every test: temp HOME/USERPROFILE (so os.homedir()-based
// paths never reach the real machine), a temp AGENT_OS_HOME and managed-Node
// root, the mirror wired in, and a PATH of only the fake dir(s) plus system
// folders -- never the developer's own, where real agents live.
async function withTempEnv(fn, { extraPath = [oldNodeDir, fakeOpenDir] } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-home-"));
  const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-runtime-"));
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-managed-"));
  const basePath = [...extraPath, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
  mirrorHits = {};
  try {
    await withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        AGENT_OS_MANAGED_ROOT: managedRoot,
        AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirrorPort}`,
        PATH: basePath,
        HERMES_HOME: undefined
      },
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        clearSystemCheckCache();
        clearDetectCaches();
        resetSetupJobsForTest();
        resetSignInForTest();
        try {
          await fn({ home, agentOsHome, managedRoot });
        } finally {
          // Even when an assertion fails halfway, no fake installer or login
          // is left running (a stray one would keep this test file alive).
          await getRunManager().stopAll();
        }
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
    await rm(managedRoot, { recursive: true, force: true });
  }
}

// An agent that is "already installed": the launcher a real installer leaves.
async function installFakeAgent(home, kind) {
  await installFakeAgentAt(home, kind, agentJsPath);
}

async function readIfExists(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function waitForJob(jobId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getSetupJob(jobId);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`setup job ${jobId} did not finish within ${timeoutMs}ms`);
}

async function waitFor(check, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function codingInstallIds(agents = CODING) {
  const check = await systemCheck({ refresh: true });
  const plan = buildSetupPlan(check, { agents });
  return plan.steps.filter((s) => ["install", "prereq-node"].includes(s.action)).map((s) => s.id);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// =====================================================================
// 1. Recipes
// =====================================================================

test("recipes: official URLs per OS, the scoped Codex package, and the mirror guard", async () => {
  await withEnv({ AGENT_OS_SETUP_MIRROR: undefined }, async () => {
    const claudeMac = getInstallRecipe("claude", "darwin", "arm64");
    assert.equal(claudeMac.installerUrl, "https://claude.ai/install.sh");
    assert.equal(claudeMac.shell, "bash");
    assert.equal(claudeMac.officialCommand, "curl -fsSL https://claude.ai/install.sh | bash");
    assert.deepEqual(claudeMac.updateArgs, ["update"]);

    const claudeWin = getInstallRecipe("claude", "win32", "x64");
    assert.equal(claudeWin.installerUrl, "https://claude.ai/install.ps1");
    assert.equal(claudeWin.shell, "powershell");
    assert.equal(claudeWin.officialCommand, "irm https://claude.ai/install.ps1 | iex");

    const cursorLinux = getInstallRecipe("cursor", "linux", "x64");
    assert.equal(cursorLinux.installerUrl, "https://cursor.com/install");
    assert.equal(cursorLinux.officialCommand, "curl https://cursor.com/install -fsS | bash");
    const cursorWin = getInstallRecipe("cursor", "win32", "x64");
    assert.equal(cursorWin.installerUrl, "https://cursor.com/install?win32=true");
    assert.equal(cursorWin.shell, "powershell");

    for (const platform of ["darwin", "linux", "win32"]) {
      const codex = getInstallRecipe("codex", platform, "x64");
      assert.equal(codex.npmPackage, "@openai/codex", "the scoped package, never the unrelated 'codex'");
      assert.equal(codex.officialCommand, "npm install -g @openai/codex");
      assert.equal(codex.installerUrl, null);
    }
    for (const id of CODING) {
      const recipe = getInstallRecipe(id, "darwin", "arm64");
      assert.ok(recipe.license && recipe.termsUrl.startsWith("https://"), `${id} has a licence and a terms link`);
      assert.ok(recipe.approxMb > 0 && recipe.approxMinutes.length === 2, `${id} has an approximate size and time`);
      assert.ok(recipe.changes.length > 0 && recipe.changesSummary, `${id} says what it changes`);
    }
  });

  // Under a test mirror the installer hosts move to 127.0.0.1; any other override is ignored.
  await withEnv({ AGENT_OS_SETUP_MIRROR: "http://127.0.0.1:4567" }, async () => {
    assert.equal(getInstallRecipe("claude", "darwin", "arm64").installerUrl, "http://127.0.0.1:4567/claude.ai/install.sh");
    assert.equal(getInstallRecipe("cursor", "win32", "x64").installerUrl, "http://127.0.0.1:4567/cursor.com/install?win32=true");
    assert.equal(applyMirror("https://cursor.com/install"), "http://127.0.0.1:4567/cursor.com/install");
  });
  await withEnv({ AGENT_OS_SETUP_MIRROR: "https://evil.example" }, async () => {
    assert.equal(getInstallRecipe("claude", "linux", "x64").installerUrl, "https://claude.ai/install.sh");
  });
});

// =====================================================================
// 2. The plan, per operating system
// =====================================================================

function syntheticCheck(osName, { codexNodeOk = false, installed = {}, network = [] } = {}) {
  const detected = (id) => (installed[id] ? { installed: true, version: "1.2.3", path: `/fake/${id}` } : { installed: false });
  return {
    os: osName,
    arch: "arm64",
    tools: { node: { found: true, nodeOkForOpenClaw: false, nodeOkForCodex: codexNodeOk }, git: { found: true }, brew: { found: true } },
    agents: Object.fromEntries(["hermes", "openclaw", ...CODING].map((id) => [id, { detected: detected(id) }])),
    network
  };
}

for (const osName of ["darwin", "linux", "win32"]) {
  test(`buildSetupPlan(): coding agents on ${osName} -> installs with sizes, official commands, and Codex on the managed Node`, async () => {
    await withEnv({ AGENT_OS_SETUP_MIRROR: undefined }, async () => {
      const plan = buildSetupPlan(syntheticCheck(osName), { agents: CODING });
      const ids = plan.steps.map((s) => s.id);
      assert.deepEqual(ids, ["claude-install", "codex-prereq-node", "codex-install", "cursor-install"]);
      assert.ok(plan.steps.every((s) => s.group === "coding"));

      const claude = plan.steps.find((s) => s.id === "claude-install");
      assert.equal(claude.commandPreview, osName === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash");
      assert.ok(claude.approxMb > 0 && claude.approxMinutes[0] > 0 && claude.approxMinutes[1] >= claude.approxMinutes[0]);
      assert.match(claude.description, /temporary file/);
      assert.ok(claude.summary);

      const cursor = plan.steps.find((s) => s.id === "cursor-install");
      assert.equal(
        cursor.commandPreview,
        osName === "win32" ? "irm 'https://cursor.com/install?win32=true' | iex" : "curl https://cursor.com/install -fsS | bash"
      );

      const node = plan.steps.find((s) => s.id === "codex-prereq-node");
      assert.equal(node.action, "prereq-node");
      assert.match(node.description, /Node 22 or newer/);
      assert.ok(node.approxMb > 0);
      const codex = plan.steps.find((s) => s.id === "codex-install");
      assert.equal(codex.commandPreview, "npm install -g @openai/codex");
      assert.match(codex.description, /npm install -g @openai\/codex/);

      // With a Node 22+ already on the computer there is nothing to download first.
      const withNode = buildSetupPlan(syntheticCheck(osName, { codexNodeOk: true }), { agents: CODING });
      assert.ok(!withNode.steps.some((s) => s.id === "codex-prereq-node"));
    });
  });
}

test("buildSetupPlan(): the default plan is still the two operators; installed coding agents are kept, update is off", async () => {
  const check = syntheticCheck("darwin", { installed: { claude: true, cursor: true } });
  const operators = buildSetupPlan(check);
  assert.deepEqual([...new Set(operators.steps.map((s) => s.agentId))], ["hermes", "openclaw"]);

  const plan = buildSetupPlan(check, { agents: CODING });
  const claudeSteps = plan.steps.filter((s) => s.agentId === "claude");
  assert.deepEqual(claudeSteps.map((s) => s.action), ["keep", "update"]);
  assert.equal(claudeSteps[0].default, true);
  assert.equal(claudeSteps[0].installedVersion, "1.2.3");
  assert.equal(claudeSteps[1].default, false);
  assert.equal(claudeSteps[1].commandPreview, "/fake/claude update");
  assert.ok(!plan.steps.some((s) => s.agentId === "claude" && s.action === "install"));
  assert.ok(!plan.steps.some((s) => s.agentId === "cursor" && s.action === "install"));
  assert.ok(plan.steps.some((s) => s.id === "codex-install"), "the one that is missing is still offered");
});

test("buildSetupPlan(): an unreachable installer host blocks only that agent, with a plain reason", async () => {
  await withEnv({ AGENT_OS_SETUP_MIRROR: undefined }, async () => {
    const plan = buildSetupPlan(syntheticCheck("linux", { network: [{ host: "claude.ai", ok: false, ms: 5000 }] }), { agents: CODING });
    assert.deepEqual(plan.blocked.map((b) => b.agentId), ["claude"]);
    assert.match(plan.blocked[0].reason, /claude\.ai/);
    assert.ok(!plan.steps.some((s) => s.agentId === "claude"));
    assert.ok(plan.steps.some((s) => s.id === "cursor-install"));
  });
});

test("systemCheck(): reports the coding agents, the Codex Node rule, and the extra install hosts", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFakeAgent(home, "claude");
    const check = await systemCheck({ refresh: true });
    assert.equal(check.agents.claude.detected.installed, true);
    assert.match(check.agents.claude.detected.version, /2\.1\.900/);
    assert.equal(check.agents.codex.detected.installed, false);
    assert.equal(check.agents.cursor.detected.installed, false);
    assert.equal(check.tools.node.nodeOkForCodex, false, "the fake Node 20 is too old for Codex");
    assert.ok(check.network.some((n) => n.host === "claude.ai") && check.network.some((n) => n.host === "cursor.com"));
  });
  await withTempEnv(
    async () => {
      const check = await systemCheck({ refresh: true });
      assert.equal(check.tools.node.nodeOkForCodex, true);
      const plan = buildSetupPlan(check, { agents: CODING });
      assert.ok(!plan.steps.some((s) => s.id === "codex-prereq-node"));
    },
    { extraPath: [node22Dir] }
  );
});

// =====================================================================
// 3. Install jobs
// =====================================================================

test(
  "startSetupJob(): installs Claude Code, Cursor and Codex (on the managed Node), logs the installer live, writes a receipt",
  posixSkip,
  async () => {
    await withTempEnv(async ({ home, managedRoot }) => {
      const stepIds = await codingInstallIds();
      assert.deepEqual(stepIds, ["claude-install", "codex-prereq-node", "codex-install", "cursor-install"]);

      const job = await startSetupJob({ steps: stepIds });
      const finished = await waitForJob(job.id);
      assert.equal(finished.status, "succeeded", JSON.stringify(finished.steps.map((s) => [s.id, s.status, s.error])));

      const claude = finished.steps.find((s) => s.id === "claude-install");
      assert.ok(claude.installerSha256, "the downloaded installer is fingerprinted");
      assert.ok(claude.log.some((line) => /Downloading claude \.\.\./.test(line)), "the installer's own output is in the step log");
      assert.ok(claude.log.some((line) => /claude installed/.test(line)));

      // Codex: the managed Node was fetched, then npm was told to install the SCOPED package into it.
      const codex = finished.steps.find((s) => s.id === "codex-install");
      assert.equal(codex.status, "succeeded");
      assert.ok(codex.log.some((line) => /@openai\/codex/.test(line)));
      const npmArgs = await readFile(path.join(home, ".fake-npm-args.log"), "utf8");
      assert.equal(npmArgs.trim(), `npm install -g @openai/codex --prefix ${path.join(managedRoot, "node")}`);
      const npmPath = await readFile(path.join(home, ".fake-npm-path.log"), "utf8");
      assert.ok(npmPath.includes(path.join(managedRoot, "node", "bin")), "npm ran with the managed Node first on PATH");
      assert.ok((await stat(path.join(managedRoot, "node", "bin", "codex"))).isFile());

      clearDetectCaches();
      for (const id of CODING) assert.equal((await ADAPTERS[id].detect({ refresh: true })).installed, true, `${id} is detected afterwards`);

      const receipt = await readReceipt();
      assert.deepEqual(receipt.map((r) => r.agentId).sort(), ["claude", "codex", "cursor"]);
      assert.ok(receipt.every((r) => r.uninstall.length > 0 && r.changes.length > 0));
      assert.ok(receipt.find((r) => r.agentId === "claude").uninstall.some((u) => /~\/\.local\/share\/claude/.test(u)));
    });
  }
);

test("startSetupJob(): Codex uses a Node 22+ already on the computer, with its npm, into ~/.npm-global", posixSkip, async () => {
  await withTempEnv(
    async ({ home }) => {
      const stepIds = await codingInstallIds(["codex"]);
      assert.deepEqual(stepIds, ["codex-install"], "no Node download is planned");
      const finished = await waitForJob((await startSetupJob({ steps: stepIds })).id);
      assert.equal(finished.status, "succeeded", JSON.stringify(finished.steps.map((s) => [s.id, s.status, s.error])));
      const npmArgs = await readFile(path.join(home, ".fake-npm-args.log"), "utf8");
      assert.equal(npmArgs.trim(), `npm install -g @openai/codex --prefix ${path.join(home, ".npm-global")}`);
      assert.equal((await ADAPTERS.codex.detect({ refresh: true })).installed, true);
    },
    { extraPath: [node22Dir] }
  );
});

test("startSetupJob(): an agent that is already installed has no install step, so its installer is never even downloaded", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    for (const id of CODING) await installFakeAgent(home, id);
    const check = await systemCheck({ refresh: true });
    const plan = buildSetupPlan(check, { agents: CODING });
    assert.ok(!plan.steps.some((s) => ["install", "prereq-node"].includes(s.action)));
    assert.deepEqual(plan.steps.filter((s) => s.action === "keep").map((s) => s.agentId), CODING);

    await assert.rejects(
      () => startSetupJob({ steps: ["claude-install", "cursor-install", "codex-install"] }),
      (error) => error.code === "no_valid_steps"
    );

    // "Keep" is a valid choice and does nothing at all.
    const keepIds = plan.steps.filter((s) => s.action === "keep").map((s) => s.id);
    const finished = await waitForJob((await startSetupJob({ steps: keepIds })).id);
    assert.equal(finished.status, "succeeded");
    assert.equal(mirrorHits["/claude.ai/install.sh"] || 0, 0);
    assert.equal(mirrorHits["/cursor.com/install"] || 0, 0);
    assert.equal(await readIfExists(path.join(home, ".fake-installer-runs.log")), "");
    assert.equal(await readIfExists(path.join(home, ".fake-npm-args.log")), "");
    assert.deepEqual(await readReceipt(), [], "keeping something is not an install");
  });
});

test("startSetupJob(): a client cannot add a URL, command or flag -- unknown step ids are ignored", posixSkip, async () => {
  await withTempEnv(async () => {
    await assert.rejects(
      () => startSetupJob({ steps: ["not-a-real-step"], installerUrl: "https://evil.example/x.sh", args: ["--evil"] }),
      (error) => error.code === "no_valid_steps"
    );
    assert.equal(mirrorHits["/claude.ai/install.sh"] || 0, 0);
    assert.equal(mirrorHits["/cursor.com/install"] || 0, 0);
  });
});

test("an install job never installs over an agent that appeared since the plan (only Update replaces it)", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    // The first try leaves a working launcher behind but still reports a failure.
    await writeFile(path.join(home, ".fake-claude-partial"), "1");
    const first = await waitForJob((await startSetupJob({ steps: ["claude-install"] })).id);
    assert.equal(first.status, "failed");
    assert.equal((await readIfExists(path.join(home, ".fake-installer-runs.log"))).trim().split("\n").length, 1);

    // Retry: the agent is there now, so the installer is NOT run a second time.
    const retried = await waitForJob((await retrySetupJob(first.id)).id);
    assert.equal(retried.status, "succeeded");
    assert.equal((await readIfExists(path.join(home, ".fake-installer-runs.log"))).trim().split("\n").length, 1, "installer ran once, not twice");
    assert.ok(retried.steps[0].log.some((line) => /already installed; kept as it is/.test(line)));
  });
});

test("startSetupJob(): Update runs the agent's own `update` command and only then", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFakeAgent(home, "claude");
    const check = await systemCheck({ refresh: true });
    const update = buildSetupPlan(check, { agents: ["claude"] }).steps.find((s) => s.action === "update");
    const finished = await waitForJob((await startSetupJob({ steps: [update.id] })).id);
    assert.equal(finished.status, "succeeded");
    assert.equal((await ADAPTERS.claude.detect({ refresh: true })).version, "9.9.9-updated");
    const calls = await readFile(path.join(home, ".fake-agent-calls.log"), "utf8");
    assert.match(calls, /^claude update$/m);
    assert.equal(mirrorHits["/claude.ai/install.sh"] || 0, 0, "an update never downloads the installer");
    assert.ok(finished.steps[0].log.some((line) => /updated/.test(line)));
  });
});

test("failure then Retry: a plain reason, nothing already done is repeated", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await writeFile(path.join(home, ".fake-cursor-fail-once"), "1");
    const job = await startSetupJob({ steps: ["claude-install", "cursor-install"] });
    const failed = await waitForJob(job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.steps.find((s) => s.id === "claude-install").status, "succeeded");
    const cursor = failed.steps.find((s) => s.id === "cursor-install");
    assert.equal(cursor.status, "failed");
    assert.match(cursor.error, /could not download Cursor CLI; check your internet connection/i, "the reason is plain English, not an exit code");
    assert.ok(cursor.log.some((line) => /Could not resolve host/.test(line)), "the log still has the raw line");

    const retried = await waitForJob((await retrySetupJob(job.id)).id);
    assert.equal(retried.status, "succeeded");
    const runs = (await readIfExists(path.join(home, ".fake-installer-runs.log"))).trim().split("\n");
    assert.deepEqual(runs.map((l) => l.split(" ")[1]), ["claude", "cursor", "cursor"], "Claude Code was not installed again on Retry");
  });
});

test("a failed Codex install says why in plain English, and Retry finishes it", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await writeFile(path.join(home, ".fake-npm-fail"), "1");
    const ids = await codingInstallIds(["codex"]);
    const failed = await waitForJob((await startSetupJob({ steps: ids })).id);
    assert.equal(failed.status, "failed");
    const codex = failed.steps.find((s) => s.id === "codex-install");
    assert.match(codex.error, /could not download Codex; check your internet connection/i);
    assert.equal(failed.steps.find((s) => s.id === "codex-prereq-node").status, "succeeded");

    await rm(path.join(home, ".fake-npm-fail"));
    const retried = await waitForJob((await retrySetupJob(failed.id)).id);
    assert.equal(retried.status, "succeeded");
    const nodeDownloads = mirrorHits[`/nodejs.org/dist/latest-v24.x/${mirrorState.nodeTarballName}`] || 0;
    assert.equal(nodeDownloads, 1, "the Node that was already fetched is reused on Retry");
  });
});

test("cancel stops the whole installer tree, grandchildren included", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await writeFile(path.join(home, ".fake-claude-sleep"), "1");
    const job = await startSetupJob({ steps: ["claude-install"] });
    const pidFile = path.join(home, ".fake-sleep-pid");
    const grandchildPid = Number(await waitFor(async () => (await readIfExists(pidFile)).trim() || null, "the installer's child process"));
    assert.ok(isAlive(grandchildPid));

    const runId = await waitFor(async () => (await getSetupJob(job.id)).steps[0].runIds[0] || null, "the install run");
    const cancelled = await cancelSetupJob(job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(["stopped", "failed"].includes((await getRunManager().getRun(runId)).status));
    await waitFor(async () => !isAlive(grandchildPid), "the child process to be gone");
  });
});

// =====================================================================
// 4. Sign-in: status mapping
// =====================================================================

test("interpretStatus(): each agent's own words map to signed_in / not_signed_in / unknown, without echoing the account", () => {
  const run = (agentId, result) => interpretStatus(agentId, { ok: false, code: 1, signal: null, stdout: "", stderr: "", ...result });

  // Claude Code: JSON, exit 0 when signed in.
  assert.deepEqual(run("claude", { ok: true, code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}' }), {
    status: "signed_in",
    note: "Signed in with your Claude account."
  });
  assert.equal(run("claude", { ok: true, code: 0, stdout: '{"loggedIn":true,"authMethod":"api_key"}' }).note, "Using an Anthropic API key.");
  assert.equal(run("claude", { stdout: '{"loggedIn":false,"authMethod":"none"}' }).status, "not_signed_in");
  assert.equal(run("claude", { ok: true, code: 0, stdout: "Logged in" }).status, "signed_in", "exit 0 means signed in, per the docs");
  assert.equal(run("claude", { stderr: "Not logged in" }).status, "not_signed_in");
  assert.equal(run("claude", { stderr: "error: unknown command 'auth'" }).status, "unknown", "a bare exit 1 is not believed on its own");

  // Codex: "Not logged in" must not be read as "logged in".
  assert.deepEqual(run("codex", { ok: true, code: 0, stdout: "Logged in using ChatGPT" }), { status: "signed_in", note: "Signed in with ChatGPT." });
  assert.equal(run("codex", { ok: true, code: 0, stdout: "Logged in using an API key" }).note, "Using an OpenAI API key.");
  assert.equal(run("codex", { stderr: "Not logged in" }).status, "not_signed_in");
  assert.equal(run("codex", { ok: true, code: 0, stdout: "Not logged in" }).status, "not_signed_in");
  assert.equal(run("codex", { stderr: "something exploded" }).status, "unknown");

  // Cursor: the words decide.
  assert.equal(run("cursor", { ok: true, code: 0, stdout: "✓ Logged in as someone@example.com" }).status, "signed_in");
  assert.equal(run("cursor", { ok: true, code: 0, stdout: "Not logged in" }).status, "not_signed_in");
  assert.equal(run("cursor", { ok: true, code: 0, stdout: "something unexpected" }).status, "unknown");

  // The command did not finish: never a guess.
  for (const id of CODING) {
    assert.equal(run(id, { signal: "SIGTERM", code: 0 }).status, "unknown");
    assert.equal(run(id, { code: "ENOENT" }).status, "unknown");
  }
  // Nothing the agent printed about the account is passed on.
  const note = JSON.stringify(run("cursor", { ok: true, code: 0, stdout: "Logged in as someone@example.com" }));
  assert.ok(!note.includes("someone@example.com"));
});

test("signInStatus(): asks each fake agent itself; not installed is its own answer", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    for (const id of CODING) {
      const missing = await signInStatus(id);
      assert.equal(missing.installed, false);
      assert.equal(missing.status, "unknown");
      assert.match(missing.note, /isn't installed yet/);
      assert.ok(missing.cost.length > 20);
    }

    for (const id of CODING) await installFakeAgent(home, id);
    for (const id of CODING) assert.equal((await signInStatus(id)).status, "not_signed_in", `${id} signed out`);

    for (const id of CODING) await writeFile(path.join(home, `.fake-signed-in-${id}`), "1");
    const claude = await signInStatus("claude");
    assert.deepEqual([claude.status, claude.note], ["signed_in", "Signed in with your Claude account."]);
    assert.equal((await signInStatus("codex")).note, "Signed in with ChatGPT.");
    const cursor = await signInStatus("cursor");
    assert.equal(cursor.status, "signed_in");
    assert.ok(!JSON.stringify([claude, cursor]).includes("someone@example.com"), "no account details come back");
    assert.ok(!JSON.stringify(claude).includes("Secret Org"));

    await writeFile(path.join(home, ".fake-status-broken"), "1");
    assert.equal((await signInStatus("claude")).status, "unknown", "a status command that errors is 'can't tell', not 'signed out'");

    await assert.rejects(() => signInStatus("hermes"), (error) => error.code === "invalid_agent");
    await assert.rejects(() => startSignIn("openclaw"), (error) => error.code === "invalid_agent");
  });
});

// =====================================================================
// 5. Sign-in: the login run
// =====================================================================

async function waitForRun(agentId, done, what) {
  return waitFor(async () => {
    const summary = await latestRunSummary(agentId);
    return summary && done(summary) ? summary : null;
  }, what);
}

test("startSignIn(): runs the agent's own login as a visible run, then the agent reports signed in", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    for (const id of CODING) await installFakeAgent(home, id);
    for (const [id, args] of [["claude", "auth login"], ["codex", "login"], ["cursor", "login"]]) {
      const started = await startSignIn(id);
      assert.ok(["queued", "running", "succeeded"].includes(started.status));
      const done = await waitForRun(id, (r) => r.status === "succeeded", `${id} login to finish`);
      assert.equal(done.exitCode, 0);
      assert.equal(done.reason, null);
      assert.equal(done.url, null, "the link is only offered while the login is open");
      assert.ok(done.lines.some((l) => /Login successful/.test(l)), "the command's own output is visible");
      assert.equal((await signInStatus(id)).status, "signed_in");

      const calls = await readFile(path.join(home, ".fake-agent-calls.log"), "utf8");
      assert.match(calls, new RegExp(`^${id} ${args}$`, "m"));

      const meta = await getRunManager().getRun(started.id);
      assert.equal(meta.kind, "signin");
      assert.equal(meta.agentId, id);
    }
    // Only version/help/status/login (and nothing else) was ever run on any agent.
    const calls = (await readFile(path.join(home, ".fake-agent-calls.log"), "utf8")).trim().split("\n");
    for (const line of calls) {
      assert.match(line, /^(claude|codex|cursor) (--version|--help|exec --help|auth login|auth status|login|login status|status)$/);
    }
  });
});

test("startSignIn(): a login that fails says so in plain words and keeps Try again possible", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFakeAgent(home, "codex");
    await writeFile(path.join(home, ".fake-login-fail"), "1");
    await startSignIn("codex");
    const failed = await waitForRun("codex", (r) => r.status === "failed", "the login to fail");
    assert.match(failed.reason, /Codex sign-in stopped before it finished\. It said: login failed/);
    assert.equal(failed.needsTerminal, false);
    assert.equal((await signInStatus("codex")).status, "not_signed_in");

    await rm(path.join(home, ".fake-login-fail"));
    await startSignIn("codex");
    await waitForRun("codex", (r) => r.status === "succeeded", "the second try to succeed");
    assert.equal((await signInStatus("codex")).status, "signed_in");
  });
});

test("startSignIn(): a login that needs a terminal is recognised and says so plainly", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFakeAgent(home, "claude");
    await writeFile(path.join(home, ".fake-login-notty"), "1");
    await startSignIn("claude");
    const failed = await waitForRun("claude", (r) => r.status === "failed", "the login to fail");
    assert.equal(failed.needsTerminal, true);
    assert.match(failed.reason, /needs a terminal window/);
  });
});

test("startSignIn(): Cancel stops an open login; a second start while one is open is refused", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFakeAgent(home, "cursor");
    await writeFile(path.join(home, ".fake-login-sleep"), "1");
    const started = await startSignIn("cursor");
    // The link comes on the first line; the long opaque string on the third.
    const open = await waitForRun("cursor", (r) => r.status === "running" && r.url && r.lines.length >= 3, "the login link and its output");
    assert.equal(open.url, "https://cursor.com/loginDeepControl?uuid=abc", "only the agent's own site is offered, never the evil.example link");
    assert.ok(open.lines.every((l) => !l.includes("x".repeat(40))), "long opaque strings are hidden");
    assert.ok(open.lines.some((l) => /\[hidden\]/.test(l)));

    await assert.rejects(() => startSignIn("cursor"), (error) => error.code === "signin_in_progress");

    const pid = (await getRunManager().getRun(started.id)).pid;
    const cancelled = await cancelSignIn("cursor");
    assert.equal(cancelled.status, "stopped");
    assert.match(cancelled.reason, /cancelled/);
    await waitFor(async () => !isAlive(pid), "the login process to be gone");

    // And a new sign-in is allowed again afterwards.
    await rm(path.join(home, ".fake-login-sleep"));
    await startSignIn("cursor");
    await waitForRun("cursor", (r) => r.status === "succeeded", "the new login");
  });
});

test("startSignIn(): refuses an agent that is not installed", posixSkip, async () => {
  await withTempEnv(async () => {
    await assert.rejects(() => startSignIn("claude"), (error) => error.code === "agent_not_installed");
    await assert.rejects(() => openSignInInTerminal("codex"), (error) => error.code === "agent_not_installed");
    assert.equal(await latestRunSummary("claude"), null);
  });
});

// =====================================================================
// 6. The Terminal fallback
// =====================================================================

test("loginCommandLine(): quotes a path with spaces for each shell", () => {
  assert.equal(loginCommandLine("/Users/a/.local/bin/claude", ["auth", "login"], "darwin"), "/Users/a/.local/bin/claude auth login");
  assert.equal(loginCommandLine("/Users/a b/.local/bin/claude", ["auth", "login"], "linux"), "'/Users/a b/.local/bin/claude' auth login");
  assert.equal(loginCommandLine("/Users/it's/bin/agent", ["login"], "darwin"), "'/Users/it'\\''s/bin/agent' login");
  assert.equal(loginCommandLine("C:\\Users\\a b\\codex.cmd", ["login"], "win32"), '"C:\\Users\\a b\\codex.cmd" login');
});

function fakeSpawn(outcome, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    // A real `open` exits 0 as soon as Terminal has been asked; openCommandInTerminal waits for that exit.
    setImmediate(() => {
      if (outcome !== "spawn") return child.emit("error", new Error("could not start"));
      child.emit("spawn");
      return child.emit("exit", 0, null);
    });
    return child;
  };
}

test("openSignInInTerminal(): macOS writes a .command file holding ONLY the login command; other systems hand the command back", posixSkip, async () => {
  await withTempEnv(async ({ home, agentOsHome }) => {
    await installFakeAgent(home, "claude");
    const binPath = path.join(home, ".local", "bin", "claude");

    const calls = [];
    const result = await openSignInInTerminal("claude", { platform: "darwin", spawnFn: fakeSpawn("spawn", calls) });
    assert.equal(result.opened, true);
    assert.equal(result.command, `${binPath} auth login`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "open");
    assert.deepEqual(calls[0].args.slice(0, 2), ["-a", "Terminal"]);
    assert.equal(calls[0].options.shell, false);
    const file = calls[0].args[2];
    assert.ok(file.startsWith(path.join(agentOsHome, "setup", "terminal")) && file.endsWith(".command"));
    assert.equal(await readFile(file, "utf8"), `${binPath} auth login\n`, "nothing but the one fixed command");
    assert.equal((await stat(file)).mode & 0o777, 0o700);

    // Terminal could not be started: say so, and still hand back the command.
    const failed = await openSignInInTerminal("claude", { platform: "darwin", spawnFn: fakeSpawn("error", []) });
    assert.deepEqual([failed.opened, failed.reason, failed.command], [false, "spawn_failed", `${binPath} auth login`]);

    for (const platform of ["linux", "win32"]) {
      const copy = await openSignInInTerminal("claude", { platform, spawnFn: () => assert.fail("must not spawn") });
      assert.deepEqual([copy.opened, copy.reason], [false, "copy"]);
      assert.ok(copy.command.endsWith("claude auth login"));
    }
  });
});

// =====================================================================
// 7. No credential file is ever opened
// =====================================================================

test("no credential file is ever opened: status, sign-in, Terminal fallback and detection never touch ~/.claude, ~/.codex, ~/.cursor or auth.json", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    for (const id of CODING) await installFakeAgent(home, id);
    const seen = [];
    const restore = spyOnFileAccess(seen);
    try {
      clearDetectCaches();
      for (const id of CODING) {
        await signInStatus(id);
        await startSignIn(id);
        await waitForRun(id, (r) => r.status !== "running" && r.status !== "queued", `${id} login to end`);
        await openSignInInTerminal(id, { platform: "darwin", spawnFn: fakeSpawn("spawn", []) });
        await signInStatus(id);
      }
    } finally {
      restore();
    }
    // The spy really sees file access (a control), and not one path is a credential file.
    assert.ok(seen.some((p) => p.includes(path.join(home, ".local", "bin"))), "the spy saw the agents' launchers being looked up");
    assert.ok(seen.length > 20, `expected many recorded calls, got ${seen.length}`);
    assert.deepEqual(seen.filter((p) => FORBIDDEN_PATH.test(p)), []);
  });
});

test("signin.js has no way to read a file: no read calls and no credential paths in its code", async () => {
  const source = await readFile(path.join(root, "server", "runtime", "setup", "signin.js"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  for (const forbidden of ["readFile", "createReadStream", "openSync"]) {
    assert.ok(!code.includes(forbidden), `signin.js must not call ${forbidden}`);
  }
  // No path to an agent's folder or a secrets file, as a string or a path piece.
  assert.doesNotMatch(code, /["'`/\\]\.(claude|codex|cursor|hermes|openclaw)\b/);
  assert.doesNotMatch(code, /auth\.json|["'`/\\]\.env\b/);
});

// =====================================================================
// 8. Over HTTP, against the real server
// =====================================================================

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function killChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test("HTTP: plan groups, validated sign-in routes, a full login, cancel, and the Terminal fallback", posixSkip, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-http-home-"));
  const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-http-runtime-"));
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-os-builders-http-managed-"));
  mirrorHits = {};
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const TOKEN = "test-builders-token-123";
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    HOME: homeDir,
    USERPROFILE: homeDir,
    AGENT_OS_HOME: agentOsHome,
    AGENT_OS_MANAGED_ROOT: managedRoot,
    AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirrorPort}`,
    AGENT_OS_TOKEN: TOKEN,
    AGENT_OS_NO_BROWSER: "1",
    HERMES_AGENT_OS_SCHEDULER: "0",
    SHELL: FAKE_LOGIN_SHELL, // the sessions' login-shell read (SP3, ruling R15): never the developer's own shell setup
    PATH: [oldNodeDir, fakeOpenDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter)
  };
  for (const key of ["HERMES_HOME", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_REQUIRE_AUTH", "HERMES_AGENT_OS_ENABLE_EXEC", "AGENT_OS_LIVE_CHAT"]) {
    delete env[key];
  }
  const child = spawn(process.execPath, ["server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));
  const headers = { "Content-Type": "application/json", "x-agent-os-token": TOKEN };
  const get = (url) => fetch(`${base}${url}`, { headers });
  const post = (url, body) => fetch(`${base}${url}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });

  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      if (child.exitCode != null) throw new Error(`server exited early:\n${logs.slice(-2000)}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // still booting
      }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // The default plan is the two operators; ?group=coding is the other three.
    const operators = await (await get("/api/setup/plan")).json();
    assert.deepEqual([...new Set(operators.steps.map((s) => s.agentId))], ["hermes", "openclaw"]);
    const coding = await (await get("/api/setup/plan?group=coding")).json();
    assert.deepEqual(coding.steps.map((s) => s.id), ["claude-install", "codex-prereq-node", "codex-install", "cursor-install"]);
    assert.ok(coding.steps.every((s) => s.group === "coding"));
    const all = await (await get("/api/setup/plan?group=all")).json();
    assert.equal(all.steps.length, operators.steps.length + coding.steps.length);

    // Sign-in routes: validated agent, confirm required, nothing installed yet.
    assert.equal((await get("/api/setup/signin/hermes")).status, 404);
    assert.equal((await post("/api/setup/signin/hermes", { confirm: true })).status, 404);
    assert.equal((await post("/api/setup/signin/claude", {})).status, 400);
    const notInstalled = await (await get("/api/setup/signin/claude")).json();
    assert.equal(notInstalled.installed, false);
    assert.match(notInstalled.cost, /Pro, Max, Team or Enterprise/);
    assert.match(notInstalled.cost, /free Claude\.ai plan doesn't include/);
    assert.equal((await post("/api/setup/signin/claude", { confirm: true })).status, 409, "not installed -> a plain refusal");

    // Install a fake Claude Code and Cursor, then sign in over HTTP.
    await installFakeAgent(homeDir, "claude");
    await installFakeAgent(homeDir, "cursor");
    const signedOut = await (await get("/api/setup/signin/claude")).json();
    assert.deepEqual([signedOut.installed, signedOut.status], [true, "not_signed_in"]);
    assert.equal(signedOut.run, null);

    const startRes = await post("/api/setup/signin/claude", { confirm: true });
    assert.equal(startRes.status, 200);
    const started = await startRes.json();
    assert.ok(started.run.id);
    const finished = await waitFor(async () => {
      const body = await (await get("/api/setup/signin/claude?status=0")).json();
      return body.run && body.run.status === "succeeded" ? body : null;
    }, "the login to finish over HTTP");
    assert.equal(finished.status, undefined, "?status=0 skips the slower status check");
    const after = await (await get("/api/setup/signin/claude")).json();
    assert.deepEqual([after.status, after.note], ["signed_in", "Signed in with your Claude account."]);
    const wire = JSON.stringify([started, finished, after]);
    assert.ok(!wire.includes("someone@example.com") && !wire.includes("Secret Org"), "no account details on the wire");

    // Cancel an open login with DELETE.
    await writeFile(path.join(homeDir, ".fake-login-sleep"), "1");
    assert.equal((await post("/api/setup/signin/cursor", { confirm: true })).status, 200);
    await waitFor(async () => (await (await get("/api/setup/signin/cursor?status=0")).json()).run?.status === "running", "the open login");
    const cancel = await fetch(`${base}/api/setup/signin/cursor`, { method: "DELETE", headers });
    assert.equal((await cancel.json()).run.status, "stopped");

    // The Terminal fallback needs confirm; macOS opens the fake `open`, others return the command.
    assert.equal((await post("/api/setup/signin/claude/terminal", {})).status, 400);
    const terminal = await (await post("/api/setup/signin/claude/terminal", { confirm: true })).json();
    assert.match(terminal.command, /claude auth login$/);
    if (process.platform === "darwin") {
      assert.equal(terminal.opened, true);
      const openCalls = await waitFor(async () => (await readIfExists(path.join(homeDir, ".fake-open-calls.log"))) || null, "the fake open call");
      assert.match(openCalls, /^-a Terminal .*claude-login-[0-9a-f]+\.command$/m);
    } else {
      assert.deepEqual([terminal.opened, terminal.reason], [false, "copy"]);
    }
  } finally {
    await killChild(child);
    await rm(homeDir, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
    await rm(managedRoot, { recursive: true, force: true });
  }
});
