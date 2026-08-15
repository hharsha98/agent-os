#!/usr/bin/env node
import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const required = process.env.HERMES_DOCKER_SMOKE_REQUIRED === "1";
const timeoutMs = Number(process.env.HERMES_DOCKER_SMOKE_TIMEOUT_MS || 600000);
const image = process.env.HERMES_DOCKER_SMOKE_IMAGE || `hermes-agent-os-smoke:${Date.now()}`;
const suffix = `${process.pid}-${Date.now()}`;
const container = process.env.HERMES_DOCKER_SMOKE_CONTAINER || `hermes-agent-os-smoke-${suffix}`;
const volume = process.env.HERMES_DOCKER_SMOKE_VOLUME || `hermes-agent-os-smoke-data-${suffix}`;

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: root, timeout: options.timeout || timeoutMs, env: process.env }, (error, stdout, stderr) => {
      const result = {
        cmd,
        args,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || "",
        code: error?.code || 0,
        signal: error?.signal || null
      };
      if (error) {
        const next = new Error(`${cmd} ${args.join(" ")} failed`);
        next.result = result;
        reject(next);
        return;
      }
      resolve(result);
    });
  });
}

async function findPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Could not allocate a local smoke-test port."));
      });
    });
  });
}

async function dockerAvailable() {
  try {
    await run("docker", ["info"], { timeout: 15000 });
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error.result?.stderr || error.result?.stdout || error.message
    };
  }
}

async function waitForJson(url, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok) return body;
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || "timeout"}`);
}

async function containerHealth() {
  try {
    const result = await run("docker", ["inspect", "--format", "{{.State.Health.Status}}", container], { timeout: 10000 });
    return result.stdout || "unknown";
  } catch {
    return "unknown";
  }
}

async function waitForContainerHealth() {
  const deadline = Date.now() + timeoutMs;
  let status = "unknown";
  while (Date.now() < deadline) {
    status = await containerHealth();
    if (status === "healthy") return status;
    if (status === "unhealthy") throw new Error("Docker healthcheck reported unhealthy.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Docker healthcheck did not become healthy: ${status}`);
}

async function cleanup() {
  await run("docker", ["rm", "-f", container], { timeout: 30000 }).catch(() => null);
  await run("docker", ["volume", "rm", "-f", volume], { timeout: 30000 }).catch(() => null);
  if (process.env.HERMES_DOCKER_SMOKE_KEEP_IMAGE !== "1") {
    await run("docker", ["image", "rm", "-f", image], { timeout: 30000 }).catch(() => null);
  }
}

async function main() {
  const availability = await dockerAvailable();
  if (!availability.available) {
    const result = {
      ok: !required,
      skipped: true,
      reason: availability.reason,
      required
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(required ? 1 : 0);
  }

  const port = Number(process.env.HERMES_DOCKER_SMOKE_PORT || (await findPort()));
  const buildArgs = ["build", "-t", image];
  if (process.env.HERMES_DOCKER_SMOKE_PULL === "1") buildArgs.push("--pull");
  buildArgs.push(".");

  try {
    await run("docker", buildArgs, { timeout: timeoutMs });
    await run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "hermes-agent-os.smoke=true",
      "--mount",
      `type=volume,source=${volume},target=/data/hermes-agent-os`,
      "-p",
      `127.0.0.1:${port}:4173`,
      "-e",
      "NODE_ENV=production",
      "-e",
      "PORT=4173",
      "-e",
      "HERMES_AGENT_OS_HOME=/data/hermes-agent-os",
      "-e",
      "HERMES_AGENT_OS_ENABLE_EXEC=0",
      "-e",
      "HERMES_AGENT_OS_ENABLE_INSTALL=0",
      "-e",
      "HERMES_AGENT_OS_SCHEDULER=1",
      "-e",
      "HERMES_AGENT_OS_PUBLIC_MODE=0",
      "-e",
      "HERMES_AGENT_OS_REQUIRE_AUTH=0",
      "--health-interval=2s",
      "--health-timeout=2s",
      "--health-retries=30",
      "--health-start-period=2s",
      image
    ], { timeout: 30000 });

    const base = `http://127.0.0.1:${port}`;
    const health = await waitForJson(`${base}/api/health`, "health endpoint");
    const kernel = await waitForJson(`${base}/api/os/kernel`, "kernel endpoint");
    const modules = await waitForJson(`${base}/api/modules`, "modules endpoint");
    const status = await waitForContainerHealth();
    const text = JSON.stringify({ health, kernel, modules });
    if (text.includes(process.env.HOME || "__NO_HOME__")) {
      throw new Error("Docker smoke response leaked the host home path.");
    }

    console.log(JSON.stringify({
      ok: true,
      skipped: false,
      image,
      container,
      volume,
      baseUrl: base,
      dockerHealth: status,
      service: health.service,
      mode: health.mode,
      kernelComponents: kernel.components?.length || 0,
      modules: modules.modules?.length || 0
    }, null, 2));
  } catch (error) {
    const logs = await run("docker", ["logs", "--tail", "120", container], { timeout: 30000 }).catch((logError) => logError.result || null);
    console.error(JSON.stringify({
      ok: false,
      skipped: false,
      error: error.message,
      command: error.result,
      logs
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

await main();
