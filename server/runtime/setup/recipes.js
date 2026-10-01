// A fixed table of what the OFFICIAL Hermes/OpenClaw installers need to run
// unattended. Nothing here is ever built from request input: a route only
// picks an agent id, which selects one row of this table -- never a URL,
// command, or flag supplied by a client.
const MIRROR_ENV = "AGENT_OS_SETUP_MIRROR";

// Test-only escape hatch: a suite can point the official hosts at a local
// http mirror. Anything that isn't an explicit 127.0.0.1 override is ignored
// (with a warning), so a stray env var can never redirect a real install.
export function applyMirror(url) {
  const mirror = process.env[MIRROR_ENV];
  if (!mirror) return url;
  if (!mirror.startsWith("http://127.0.0.1:")) {
    console.warn(`Ignoring ${MIRROR_ENV}: only a http://127.0.0.1:<port> override is honoured (got "${mirror}").`);
    return url;
  }
  const original = new URL(url);
  // The mirror is one server standing in for several official hosts, so the
  // original hostname becomes a path segment instead of colliding on "/".
  return new URL(`${original.hostname}${original.pathname}${original.search}`, mirror).toString();
}

function hermesRecipe(platform, arch) {
  const isWindows = platform === "win32";
  return {
    agentId: "hermes",
    label: "Hermes Agent",
    license: "MIT",
    sourceUrl: "https://github.com/NousResearch/hermes-agent",
    docsUrl: "https://hermes-agent.nousresearch.com/docs",
    installerUrl: applyMirror(
      isWindows ? "https://hermes-agent.nousresearch.com/install.ps1" : "https://hermes-agent.nousresearch.com/install.sh"
    ),
    shell: isWindows ? "powershell" : "bash",
    // Verified by reading both scripts on 2026-09-24: install.sh maps
    // --skip-setup onto the same switch as --non-interactive, so sending both
    // is harmless (belt and suspenders). install.ps1 has no -SkipSetup at
    // all -- -NonInteractive alone already skips the setup/gateway stages.
    args: isWindows ? ["-NonInteractive"] : ["--non-interactive", "--skip-setup"],
    supportsStages: true,
    manifestArgs: isWindows ? ["-Manifest"] : ["--manifest"],
    stageFlag: isWindows ? "-Stage" : "--stage",
    // Appended after "--stage NAME" / "-Stage NAME" for each per-stage run.
    stageArgs: isWindows ? ["-Json", "-NonInteractive"] : ["--json", "--non-interactive", "--skip-setup"],
    updateArgs: ["update", "--yes"],
    changes: [
      "Creates ~/.hermes (its own Python, its own Node, config, and the Hermes code)",
      "Adds ~/.local/bin to PATH in your shell startup files",
      "On macOS, may open Apple's developer tools installer if Git is missing",
      "On Linux, may install Git via your package manager if missing"
    ],
    passwordMoments: [],
    // NOTE: the spec this recipe was written from asserts Intel Macs are
    // unsupported. Reading install.sh on 2026-09-24 found no such check --
    // darwin-x64 has a valid pinned uv build and no platform/arch gate in
    // check_platform(). Kept here because the approved spec's test suite
    // requires this behavior; see the deliverable report for the discrepancy.
    ...(platform === "darwin" && arch === "x64" ? { unsupportedReason: "Hermes Agent does not support Intel Macs yet." } : {})
  };
}

function openclawRecipe(platform, arch) {
  const isWindows = platform === "win32";
  return {
    agentId: "openclaw",
    label: "OpenClaw",
    license: "MIT",
    sourceUrl: "https://github.com/openclaw/openclaw",
    docsUrl: "https://openclaw.ai/docs",
    installerUrl: applyMirror(isWindows ? "https://openclaw.ai/install.ps1" : "https://openclaw.ai/install.sh"),
    shell: isWindows ? "powershell" : "bash",
    args: isWindows ? ["-NoOnboard"] : ["--no-onboard", "--no-prompt"],
    supportsStages: false,
    updateArgs: ["update", "--yes", "--json"],
    changes: [
      "Installs the openclaw npm package globally (or into ~/.npm-global if the global folder isn't writable)",
      "Normally installs Node via Homebrew/winget/NodeSource if none is found -- Agent OS Setup avoids this by providing a managed Node first",
      "May install a gateway background service"
    ],
    passwordMoments: []
  };
}

const BUILDERS = { hermes: hermesRecipe, openclaw: openclawRecipe };

export function getInstallRecipe(agentId, platform = process.platform, arch = process.arch) {
  const builder = BUILDERS[agentId];
  if (!builder) throw new Error(`No install recipe for "${agentId}".`);
  return builder(platform, arch);
}
