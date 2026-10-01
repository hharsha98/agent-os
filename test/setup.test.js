// Setup Assistant backend: system check, install plan, the job runner
// (against a local http mirror standing in for the official installer
// hosts), and the /api/setup HTTP surface. Every test uses a temp HOME,
// AGENT_OS_HOME and AGENT_OS_MANAGED_ROOT -- nothing here may touch the
// real ~/.hermes, ~/.openclaw, ~/.agent-os, or shell rc files. Anything that
// spawns a fake installer (a real shebang script) is POSIX-only, matching
// the pattern already used by test/agents.test.js and test/runtime.test.js.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { ensureManagedNode } from "../server/runtime/setup/managed-node.js";
import { clearSystemCheckCache, systemCheck } from "../server/runtime/setup/system-check.js";
import { buildSetupPlan } from "../server/runtime/setup/plan.js";
import {
  cancelSetupJob,
  getSetupJob,
  resetSetupJobsForTest,
  retrySetupJob,
  startSetupJob
} from "../server/runtime/setup/jobs.js";
import { readReceipt } from "../server/runtime/setup/receipt.js";

const isWindows = process.platform === "win32";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FAKE_HERMES_CLI_SOURCE = `
const args = process.argv.slice(2);
function print(t) { process.stdout.write(t + "\\n"); }
if (args.includes("--version")) { print("hermes 0.99.0-test"); process.exit(0); }
if (args[0] === "chat" && args.includes("--help")) { print("Usage: hermes chat\\n  --query-file PATH\\n  --oneshot\\n  -Q, --quiet"); process.exit(0); }
if (args[0] === "doctor") { print("Everything looks good."); process.exit(0); }
if (args[0] === "config" && args[1] === "get") { print("on"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "status") { print("gateway is not running"); process.exit(0); }
if (args[0] === "update") { print("hermes updated"); process.exit(0); }
print("fake-hermes: " + JSON.stringify(args));
process.exit(0);
`;

const FAKE_OPENCLAW_CLI_SOURCE = `
const args = process.argv.slice(2);
function print(t) { process.stdout.write(t + "\\n"); }
if (args.includes("--version")) { print("openclaw 9.9.9-test"); process.exit(0); }
if (args[0] === "agent" && args[1] === "exec" && args.includes("--help")) { print("Usage\\n --message-file PATH\\n --cwd DIR\\n --json"); process.exit(0); }
if (args[0] === "doctor") { print(JSON.stringify({ ok: true, findings: [] })); process.exit(0); }
if (args[0] === "status") { print(JSON.stringify({ ok: true })); process.exit(0); }
if (args[0] === "config" && args[1] === "get") { print("full"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "status") { print(JSON.stringify({ running: false })); process.exit(0); }
if (args[0] === "update") { print(JSON.stringify({ ok: true })); process.exit(0); }
print("fake-openclaw: " + JSON.stringify(args));
process.exit(0);
`;

function buildFakeHermesInstaller(jsPath) {
  const nodeExec = process.execPath;
  return `#!/bin/bash
set -u
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/hermes" <<'SHIM'
#!/bin/sh
exec "${nodeExec}" "${jsPath}" "$@"
SHIM
chmod +x "$HOME/.local/bin/hermes"

is_manifest=false
stage=""
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[$i]}" in
    --manifest) is_manifest=true ;;
    --stage) stage="\${args[$((i+1))]}" ;;
  esac
done

if [ "$is_manifest" = true ]; then
  echo '{"protocol_version":1,"stages":[{"name":"repository","title":"Clone","category":"setup","needs_user_input":false},{"name":"config","title":"Config","category":"setup","needs_user_input":false},{"name":"complete","title":"Complete","category":"setup","needs_user_input":false}]}'
  exit 0
fi

if [ -n "$stage" ]; then
  if [ -f "$HOME/.fake-hermes-stage-fail" ]; then
    echo '{"ok":false,"stage":"'"$stage"'","skipped":false,"reason":"simulated stage failure"}'
    exit 1
  fi
  echo '{"ok":true,"stage":"'"$stage"'","skipped":false}'
  exit 0
fi

exit 0
`;
}

function buildFakeOpenclawInstaller(jsPath) {
  const nodeExec = process.execPath;
  return `#!/bin/bash
set -u
mkdir -p "$HOME/.npm-global/bin"
cat > "$HOME/.npm-global/bin/openclaw" <<'SHIM'
#!/bin/sh
exec "${nodeExec}" "${jsPath}" "$@"
SHIM
chmod +x "$HOME/.npm-global/bin/openclaw"

echo "PATH_SEEN=$PATH" >> "$HOME/.fake-openclaw-path-seen.log"

if [ -f "$HOME/.fake-openclaw-sleep" ]; then
  sleep 300
  exit 0
fi

if [ -f "$HOME/.fake-openclaw-fail-once" ] && [ ! -f "$HOME/.fake-openclaw-failed-once-done" ]; then
  touch "$HOME/.fake-openclaw-failed-once-done"
  echo "simulated failure" 1>&2
  exit 1
fi

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

// --- shared fixtures: fake CLI sources, a fake Node release tarball, and a
// local http mirror (127.0.0.1) standing in for the official hosts --------
let sourceDir = null;
let shimDir = null; // holds a fake OLD "node" shim (v22.1.0) for the "too old" case
let mirrorServer = null;
let mirrorPort = 0;
let mirrorHits = {};
const mirrorState = { hermesScript: "", openclawScript: "", nodeShasums: "", nodeTarballName: "", nodeTarballBuffer: Buffer.alloc(0) };

function resetMirrorHits() {
  mirrorHits = {};
}

before(async () => {
  if (isWindows) return;
  sourceDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-src-"));
  const fakeHermesJsPath = path.join(sourceDir, "fake-hermes-cli.mjs");
  const fakeOpenclawJsPath = path.join(sourceDir, "fake-openclaw-cli.mjs");
  await writeFile(fakeHermesJsPath, FAKE_HERMES_CLI_SOURCE);
  await writeFile(fakeOpenclawJsPath, FAKE_OPENCLAW_CLI_SOURCE);

  shimDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-bin-"));
  const oldNodeShim = path.join(shimDir, "node");
  await writeFile(oldNodeShim, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v22.1.0"; exit 0; fi\necho "fake old node"\nexit 1\n`);
  await chmod(oldNodeShim, 0o755);

  // A tiny fake Node "release" for this exact platform/arch, so the real
  // tar/extract/rename path in managed-node.js is exercised for real.
  const archName = process.arch === "arm64" ? "arm64" : "x64";
  const osName = process.platform === "darwin" ? "darwin" : "linux";
  const ext = process.platform === "darwin" ? "tar.gz" : "tar.xz";
  const version = "24.99.0";
  const dirName = `node-v${version}-${osName}-${archName}`;
  const stageDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-nodepkg-"));
  const innerBinDir = path.join(stageDir, dirName, "bin");
  await mkdir(innerBinDir, { recursive: true });
  const nodeBinPath = path.join(innerBinDir, "node");
  await writeFile(nodeBinPath, `#!/bin/sh\necho "fake-managed-node"\n`);
  await chmod(nodeBinPath, 0o755);
  const tarballName = `${dirName}.${ext}`;
  const tarballPath = path.join(stageDir, tarballName);
  const tarFlag = ext === "tar.gz" ? "-czf" : "-cJf";
  const tarResult = spawnSync("tar", [tarFlag, tarballPath, "-C", stageDir, dirName]);
  if (tarResult.status !== 0) {
    throw new Error(`failed to build the fake node tarball: ${tarResult.stderr}`);
  }
  const tarballBuffer = await readFile(tarballPath);
  const sha256 = crypto.createHash("sha256").update(tarballBuffer).digest("hex");
  await rm(stageDir, { recursive: true, force: true });

  mirrorState.hermesScript = buildFakeHermesInstaller(fakeHermesJsPath);
  mirrorState.openclawScript = buildFakeOpenclawInstaller(fakeOpenclawJsPath);
  mirrorState.nodeShasums = `${sha256}  ${tarballName}\n`;
  mirrorState.nodeTarballName = tarballName;
  mirrorState.nodeTarballBuffer = tarballBuffer;

  mirrorServer = http.createServer((req, res) => {
    mirrorHits[req.url] = (mirrorHits[req.url] || 0) + 1;
    if (req.url === "/hermes-agent.nousresearch.com/install.sh") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(mirrorState.hermesScript);
      return;
    }
    if (req.url === "/openclaw.ai/install.sh") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(mirrorState.openclawScript);
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
  if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
  if (shimDir) await rm(shimDir, { recursive: true, force: true });
});

// Full isolation for every test: temp HOME/USERPROFILE (so os.homedir()-based
// fallback paths never reach the real machine), a temp AGENT_OS_HOME, a temp
// AGENT_OS_MANAGED_ROOT, a curated PATH, and the mirror wired in.
// Defaults to the fake old node shim first on PATH: otherwise which("node")
// falls through to real install dirs (e.g. /opt/homebrew/bin) and the result
// depends on the machine -- Node 22 on one Mac, Node 24 on a CI runner.
async function withTempSetupEnv(fn, { extraPath = [shimDir] } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-home-"));
  const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-runtime-"));
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-managed-"));
  const basePath = [...extraPath, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
  resetMirrorHits();
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
        clearSystemCheckCache();
        clearDetectCaches();
        resetSetupJobsForTest();
        await fn({ home, agentOsHome, managedRoot });
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
    await rm(managedRoot, { recursive: true, force: true });
  }
}

async function installFakeHermesShim(home) {
  const jsPath = path.join(sourceDir, "fake-hermes-cli.mjs");
  const binDir = path.join(home, ".local", "bin");
  await mkdir(binDir, { recursive: true });
  const shimPath = path.join(binDir, "hermes");
  await writeFile(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`);
  await chmod(shimPath, 0o755);
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

const posixSkip = { skip: isWindows ? "spawns shebang fake installers via a local mirror (POSIX-only)" : false };

// =====================================================================
// 1. systemCheck()
// =====================================================================

test("systemCheck(): returns every key with sane types and never throws, even with PATH emptied", async () => {
  await withTempSetupEnv(async () => {
    await withEnv({ PATH: "" }, async () => {
      const check = await systemCheck({ refresh: true });
      assert.equal(typeof check.os, "string");
      assert.equal(typeof check.arch, "string");
      assert.equal(typeof check.ramGb, "number");
      assert.ok(check.freeDiskGb === null || typeof check.freeDiskGb === "number");
      assert.equal(typeof check.tools.git.found, "boolean");
      assert.equal(typeof check.tools.node.nodeOkForOpenClaw, "boolean");
      assert.ok(Array.isArray(check.network));
      assert.equal(check.network.length, 6);
      for (const entry of check.network) {
        assert.equal(typeof entry.host, "string");
        assert.equal(typeof entry.ok, "boolean");
        assert.equal(typeof entry.ms, "number");
      }
      assert.ok(check.agents.hermes && check.agents.openclaw);
    });
  });
});

// =====================================================================
// 2. Plan with nothing installed
// =====================================================================

test(
  "buildSetupPlan(): nothing installed -> install steps for both, plus prereq-node when the system node is too old",
  posixSkip,
  async () => {
    await withTempSetupEnv(
      async () => {
        const check = await systemCheck({ refresh: true });
        assert.equal(check.agents.hermes.detected.installed, false);
        assert.equal(check.agents.openclaw.detected.installed, false);
        assert.equal(check.tools.node.found, true);
        assert.match(check.tools.node.version, /22\.1\.0/);
        assert.equal(check.tools.node.nodeOkForOpenClaw, false);

        const plan = buildSetupPlan(check);
        const ids = plan.steps.map((s) => s.id);
        assert.ok(ids.includes("hermes-install"));
        assert.ok(ids.includes("openclaw-install"));
        assert.ok(ids.includes("openclaw-prereq-node"));
        assert.ok(!ids.includes("hermes-keep"));
        assert.ok(!ids.includes("openclaw-keep"));
      },
      { extraPath: [shimDir] }
    );
  }
);

// =====================================================================
// 3. Plan with Hermes already installed
// =====================================================================

test(
  "buildSetupPlan(): Hermes already installed -> keep (default), update (off), no install step",
  posixSkip,
  async () => {
    await withTempSetupEnv(async ({ home }) => {
      await installFakeHermesShim(home);
      const check = await systemCheck({ refresh: true });
      assert.equal(check.agents.hermes.detected.installed, true);
      const plan = buildSetupPlan(check);
      const hermesSteps = plan.steps.filter((s) => s.agentId === "hermes");
      const keep = hermesSteps.find((s) => s.action === "keep");
      const update = hermesSteps.find((s) => s.action === "update");
      assert.ok(keep);
      assert.equal(keep.default, true);
      assert.ok(update);
      assert.equal(update.default, false);
      assert.ok(!hermesSteps.some((s) => s.action === "install"));
    });
  }
);

// =====================================================================
// 4. Intel Mac simulation
// =====================================================================

test("buildSetupPlan(): Intel Mac -> hermes is skip-unsupported with a reason; openclaw unaffected", () => {
  const check = {
    os: "darwin",
    arch: "x64",
    tools: { node: { nodeOkForOpenClaw: true }, git: { found: true }, brew: { found: true } },
    agents: { hermes: { detected: { installed: false } }, openclaw: { detected: { installed: false } } },
    network: []
  };
  const plan = buildSetupPlan(check);
  const hermesStep = plan.steps.find((s) => s.agentId === "hermes");
  assert.equal(hermesStep.action, "skip-unsupported");
  assert.match(hermesStep.description, /Intel Mac/);
  const openclawStep = plan.steps.find((s) => s.agentId === "openclaw" && s.action === "install");
  assert.ok(openclawStep);
});

// =====================================================================
// 5. Job happy path
// =====================================================================

test(
  "startSetupJob(): happy path -- hermes staged install, openclaw with managed Node on PATH, receipt, both detected",
  posixSkip,
  async () => {
    await withTempSetupEnv(async ({ home, managedRoot }) => {
      const check = await systemCheck({ refresh: true });
      const plan = buildSetupPlan(check);
      const stepIds = plan.steps.filter((s) => ["install", "prereq-node"].includes(s.action)).map((s) => s.id);
      assert.ok(stepIds.includes("hermes-install"));
      assert.ok(stepIds.includes("openclaw-prereq-node"));
      assert.ok(stepIds.includes("openclaw-install"));

      const job = await startSetupJob({ steps: stepIds, acceptOpenClawRisk: true });
      const finished = await waitForJob(job.id);

      assert.equal(finished.status, "succeeded");
      const hermesStep = finished.steps.find((s) => s.agentId === "hermes" && s.action === "install");
      assert.equal(hermesStep.status, "succeeded");
      assert.equal(hermesStep.runIds.length, 4); // manifest + 3 stages
      assert.ok(hermesStep.installerSha256);

      const openclawStep = finished.steps.find((s) => s.agentId === "openclaw" && s.action === "install");
      assert.equal(openclawStep.status, "succeeded");

      const prereqStep = finished.steps.find((s) => s.action === "prereq-node");
      assert.equal(prereqStep.status, "succeeded");

      const pathLog = await readFile(path.join(home, ".fake-openclaw-path-seen.log"), "utf8");
      assert.ok(pathLog.includes(path.join(managedRoot, "node", "bin")));

      const receipt = await readReceipt();
      assert.equal(receipt.length, 2);
      assert.ok(receipt.every((entry) => entry.installerSha256));

      clearDetectCaches();
      const hermesDetected = await ADAPTERS.hermes.detect({ refresh: true });
      const openclawDetected = await ADAPTERS.openclaw.detect({ refresh: true });
      assert.equal(hermesDetected.installed, true);
      assert.equal(openclawDetected.installed, true);
    });
  }
);

// =====================================================================
// 6. Checksum mismatch
// =====================================================================

test("ensureManagedNode(): a checksum mismatch fails and extracts nothing", posixSkip, async () => {
  await withTempSetupEnv(
    async ({ managedRoot }) => {
      const original = mirrorState.nodeShasums;
      mirrorState.nodeShasums = `${"0".repeat(64)}  ${mirrorState.nodeTarballName}\n`;
      try {
        await assert.rejects(() => ensureManagedNode({ onProgress() {} }), /checksum/i);
      } finally {
        mirrorState.nodeShasums = original;
      }
      await assert.rejects(() => access(path.join(managedRoot, "node")));
    },
    { extraPath: [shimDir] }
  );
});

// =====================================================================
// 7. Failure + retry
// =====================================================================

test(
  "startSetupJob()/retrySetupJob(): openclaw install fails once, retry succeeds without rerunning hermes",
  posixSkip,
  async () => {
    await withTempSetupEnv(async ({ home }) => {
      await writeFile(path.join(home, ".fake-openclaw-fail-once"), "1");
      const check = await systemCheck({ refresh: true });
      const plan = buildSetupPlan(check);
      const stepIds = plan.steps.filter((s) => ["install", "prereq-node"].includes(s.action)).map((s) => s.id);

      const job = await startSetupJob({ steps: stepIds, acceptOpenClawRisk: true });
      const failed = await waitForJob(job.id);
      assert.equal(failed.status, "failed");

      const hermesStep = failed.steps.find((s) => s.agentId === "hermes" && s.action === "install");
      assert.equal(hermesStep.status, "succeeded");
      const hermesRunCount = hermesStep.runIds.length;

      const openclawStep = failed.steps.find((s) => s.agentId === "openclaw" && s.action === "install");
      assert.equal(openclawStep.status, "failed");
      assert.match(openclawStep.error, /failure/i);

      const retried = await retrySetupJob(job.id);
      const finished = await waitForJob(retried.id);
      assert.equal(finished.status, "succeeded");

      const hermesStepAfter = finished.steps.find((s) => s.agentId === "hermes" && s.action === "install");
      assert.equal(hermesStepAfter.runIds.length, hermesRunCount);

      const openclawStepAfter = finished.steps.find((s) => s.agentId === "openclaw" && s.action === "install");
      assert.equal(openclawStepAfter.status, "succeeded");
    });
  }
);

// =====================================================================
// 8. Cancel
// =====================================================================

test("cancelSetupJob(): a sleeping fake installer gets stopped and the job is cancelled", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await writeFile(path.join(home, ".fake-openclaw-sleep"), "1");
    const check = await systemCheck({ refresh: true });
    const plan = buildSetupPlan(check);
    const openclawInstallId = plan.steps.find((s) => s.agentId === "openclaw" && s.action === "install").id;
    const prereqStep = plan.steps.find((s) => s.action === "prereq-node");
    const stepIds = prereqStep ? [prereqStep.id, openclawInstallId] : [openclawInstallId];

    const job = await startSetupJob({ steps: stepIds, acceptOpenClawRisk: true });

    const deadline = Date.now() + 30000;
    let openclawStep;
    while (Date.now() < deadline) {
      const current = await getSetupJob(job.id);
      openclawStep = current.steps.find((s) => s.agentId === "openclaw" && s.action === "install");
      if (openclawStep && openclawStep.runIds.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(openclawStep && openclawStep.runIds.length > 0, "the openclaw install run did not start in time");
    const runId = openclawStep.runIds[0];

    const cancelled = await cancelSetupJob(job.id);
    assert.equal(cancelled.status, "cancelled");

    const run = await getRunManager().getRun(runId);
    assert.ok(["stopped", "failed", "timed_out"].includes(run.status));
    if (run.pid) {
      assert.throws(() => process.kill(run.pid, 0));
    }
  });
});

// =====================================================================
// 9. OpenClaw consent
// =====================================================================

test("startSetupJob(): openclaw install without acceptOpenClawRisk is rejected", posixSkip, async () => {
  await withTempSetupEnv(async () => {
    const check = await systemCheck({ refresh: true });
    const plan = buildSetupPlan(check);
    const openclawInstallId = plan.steps.find((s) => s.agentId === "openclaw" && s.action === "install").id;
    await assert.rejects(
      () => startSetupJob({ steps: [openclawInstallId] }),
      (error) => error.code === "openclaw_risk_not_accepted"
    );
  });
});

// =====================================================================
// 10. Client can't inject steps
// =====================================================================

test(
  "startSetupJob(): a step id outside the fresh plan is ignored -- the mirror never sees a request",
  posixSkip,
  async () => {
    await withTempSetupEnv(async () => {
      await assert.rejects(
        () =>
          startSetupJob({
            steps: ["not-a-real-step-id"],
            acceptOpenClawRisk: true,
            installerUrl: "https://evil.example/x.sh",
            args: ["--evil"]
          }),
        (error) => error.code === "no_valid_steps"
      );
      assert.equal(mirrorHits["/hermes-agent.nousresearch.com/install.sh"] || 0, 0);
      assert.equal(mirrorHits["/openclaw.ai/install.sh"] || 0, 0);
    });
  }
);

// =====================================================================
// 11. Mirror guard
// =====================================================================

test("applyMirror(): a non-127.0.0.1 override is ignored; the recipe keeps the official URL", async () => {
  await withEnv({ AGENT_OS_SETUP_MIRROR: "https://evil.example" }, async () => {
    const recipe = getInstallRecipe("hermes", "darwin", "arm64");
    assert.equal(recipe.installerUrl, "https://hermes-agent.nousresearch.com/install.sh");
  });
});

// =====================================================================
// 12. Existing-install protection
// =====================================================================

test(
  "startSetupJob(): hermes already installed -> no install step exists, so the fake installer is never downloaded",
  posixSkip,
  async () => {
    await withTempSetupEnv(async ({ home }) => {
      await installFakeHermesShim(home);
      const check = await systemCheck({ refresh: true });
      assert.equal(check.agents.hermes.detected.installed, true);
      const plan = buildSetupPlan(check);
      assert.ok(!plan.steps.some((s) => s.agentId === "hermes" && s.action === "install"));

      await assert.rejects(
        () => startSetupJob({ steps: ["hermes-install"], acceptOpenClawRisk: true }),
        (error) => error.code === "no_valid_steps"
      );
      assert.equal(mirrorHits["/hermes-agent.nousresearch.com/install.sh"] || 0, 0);
    });
  }
);

// =====================================================================
// 13. Routes via the real server
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

function collectLogs(child) {
  const ref = { text: "" };
  child.stdout.on("data", (chunk) => {
    ref.text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    ref.text += chunk;
  });
  return ref;
}

async function waitForHealth(base, child, logsRef) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logsRef.text.slice(-2000)}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become healthy at ${base}:\n${logsRef.text.slice(-2000)}`);
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

test(
  "setup routes: check, plan, jobs without confirm -> 400, a full job over HTTP, receipt",
  posixSkip,
  async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-http-home-"));
    const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-http-runtime-"));
    const managedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-http-managed-"));
    resetMirrorHits();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const TOKEN = "test-setup-token-123";
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
      HERMES_AGENT_OS_SCHEDULER: "0",
      PATH: `${shimDir}${path.delimiter}/usr/bin:/bin:/usr/sbin:/sbin`
    };
    for (const key of ["HERMES_HOME", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_ENABLE_EXEC", "AGENT_OS_LIVE_CHAT"]) {
      delete env[key];
    }
    const child = spawn(process.execPath, ["server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const logs = collectLogs(child);
    const authed = { "x-agent-os-token": TOKEN };
    const authedJson = { "Content-Type": "application/json", "x-agent-os-token": TOKEN };

    try {
      await waitForHealth(base, child, logs);

      const checkRes = await fetch(`${base}/api/setup/check`, { headers: authed });
      assert.equal(checkRes.status, 200);
      const checkBody = await checkRes.json();
      assert.equal(checkBody.agents.hermes.detected.installed, false);

      const planRes = await fetch(`${base}/api/setup/plan`, { headers: authed });
      assert.equal(planRes.status, 200);
      const planBody = await planRes.json();
      const stepIds = planBody.steps.filter((s) => ["install", "prereq-node"].includes(s.action)).map((s) => s.id);
      assert.ok(stepIds.includes("hermes-install"));

      const noConfirmRes = await fetch(`${base}/api/setup/jobs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ steps: stepIds, acceptOpenClawRisk: true })
      });
      assert.equal(noConfirmRes.status, 400);

      const jobRes = await fetch(`${base}/api/setup/jobs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ steps: stepIds, confirm: true, acceptOpenClawRisk: true })
      });
      assert.equal(jobRes.status, 200);
      const jobBody = await jobRes.json();

      const deadline = Date.now() + 90000;
      let finalJob = jobBody;
      while (Date.now() < deadline && finalJob.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const pollRes = await fetch(`${base}/api/setup/jobs/${jobBody.id}`, { headers: authed });
        finalJob = await pollRes.json();
      }
      assert.equal(finalJob.status, "succeeded");

      const receiptRes = await fetch(`${base}/api/setup/receipt`, { headers: authed });
      assert.equal(receiptRes.status, 200);
      const receiptBody = await receiptRes.json();
      assert.ok(receiptBody.receipt.length >= 2);
    } finally {
      await killChild(child);
      await rm(homeDir, { recursive: true, force: true });
      await rm(agentOsHome, { recursive: true, force: true });
      await rm(managedRoot, { recursive: true, force: true });
    }
  }
);
