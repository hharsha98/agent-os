// A fixed table of what the OFFICIAL Hermes, OpenClaw, Claude Code, Codex and
// Cursor installers need to run unattended. Nothing here is ever built from
// request input: a route only picks an agent id, which selects one row of this
// table -- never a URL, command, or flag supplied by a client.
const MIRROR_ENV = "AGENT_OS_SETUP_MIRROR";

// Test-only escape hatch: a suite can point the official hosts at a local
// http mirror. Anything that isn't an explicit 127.0.0.1 override is ignored
// (with a warning), so a stray env var can never redirect a real install.
// The mirror, parsed properly: plain http, the loopback address 127.0.0.1, no
// user name or password, and no path (just the server's own address). A
// string-prefix test would also accept "http://127.0.0.1:1@evil.example",
// which really points at evil.example. Returns the origin, or null.
export function mirrorOrigin() {
  const raw = process.env[MIRROR_ENV];
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const plainPath = url.pathname === "/" || url.pathname === "";
    const ok =
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      plainPath &&
      !url.search &&
      !url.hash;
    return ok ? url.origin : null;
  } catch {
    return null;
  }
}

export function applyMirror(url) {
  const mirror = process.env[MIRROR_ENV];
  if (!mirror) return url;
  const origin = mirrorOrigin();
  if (!origin) {
    // (The value is not printed: it could hold a user name and password.)
    console.warn(`Ignoring ${MIRROR_ENV}: only a plain http://127.0.0.1:<port> override is honoured.`);
    return url;
  }
  const original = new URL(url);
  // The mirror is one server standing in for several official hosts, so the
  // original hostname becomes a path segment instead of colliding on "/".
  return new URL(`${original.hostname}${original.pathname}${original.search}`, origin).toString();
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

// ---- coding agents: Claude Code, Codex, Cursor ---------------------------------
// Facts below were checked on 2026-10-04 against each vendor's own install
// page and the installer script itself (read, never run), plus the CLI's
// --help for the update commands. Sizes are what the installed copy takes on
// disk (measured on a Mac); the download itself is the same or smaller, so
// they are shown as "about" figures, never as exact ones.

function claudeRecipe(platform) {
  const isWindows = platform === "win32";
  return {
    agentId: "claude",
    label: "Claude Code",
    license: "Proprietary (Anthropic Commercial Terms)",
    termsUrl: "https://www.anthropic.com/legal/commercial-terms",
    sourceUrl: "https://code.claude.com/docs/en/setup",
    docsUrl: "https://code.claude.com/docs/en/setup",
    installerUrl: applyMirror(isWindows ? "https://claude.ai/install.ps1" : "https://claude.ai/install.sh"),
    shell: isWindows ? "powershell" : "bash",
    // What the vendor tells a person to paste (shown so it can be copied);
    // Agent OS itself downloads the script to a file and runs that instead.
    officialCommand: isWindows ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash",
    // The script takes an optional "stable"/"latest"/version; none means the
    // current default. It refuses to run under sudo, which we never use.
    args: [],
    supportsStages: false,
    updateArgs: ["update"],
    approxMb: 220,
    approxMinutes: [2, 5],
    // One plain line for the Plan screen; `changes` below is the full list.
    changesSummary: "Adds its program under ~/.local/share/claude and a launcher in ~/.local/bin. May add ~/.local/bin to your PATH.",
    changes: [
      "Installs the Claude Code program under ~/.local/share/claude and puts a launcher at ~/.local/bin/claude",
      "May add ~/.local/bin to PATH in your shell startup files",
      "Creates ~/.claude for its settings (the installer also keeps a temporary download there)"
    ],
    passwordMoments: []
  };
}

// Codex ships as an npm package, so there is no installer script to fetch:
// jobs.js runs `npm install -g @openai/codex` with a Node of our own. Never
// the unscoped "codex" package, which is something else entirely.
function codexRecipe() {
  return {
    agentId: "codex",
    label: "Codex",
    license: "Apache-2.0",
    termsUrl: "https://github.com/openai/codex/blob/main/LICENSE",
    sourceUrl: "https://github.com/openai/codex",
    docsUrl: "https://developers.openai.com/codex/cli",
    installerUrl: null,
    npmPackage: "@openai/codex",
    officialCommand: "npm install -g @openai/codex",
    shell: null,
    args: [],
    supportsStages: false,
    updateArgs: ["update"],
    approxMb: 280,
    approxMinutes: [2, 5],
    changesSummary: "Installs into your own folder, no admin password. Downloads Node 24 first if yours is older than 22.",
    changes: [
      "Installs the @openai/codex npm package into your own folder (no admin password): ~/.agent-os/node, or ~/.npm-global if you already have Node 22 or newer",
      "Needs Node 22 or newer; if yours is older, Agent OS downloads its own Node 24 into ~/.agent-os/node first",
      "Does not touch your shell startup files"
    ],
    passwordMoments: []
  };
}

function cursorRecipe(platform) {
  const isWindows = platform === "win32";
  return {
    agentId: "cursor",
    label: "Cursor CLI",
    license: "Proprietary (Cursor Terms of Service)",
    termsUrl: "https://cursor.com/terms-of-service",
    sourceUrl: "https://cursor.com/docs/cli/overview",
    docsUrl: "https://cursor.com/docs/cli/overview",
    installerUrl: applyMirror(isWindows ? "https://cursor.com/install?win32=true" : "https://cursor.com/install"),
    shell: isWindows ? "powershell" : "bash",
    officialCommand: isWindows ? "irm 'https://cursor.com/install?win32=true' | iex" : "curl https://cursor.com/install -fsS | bash",
    args: [],
    supportsStages: false,
    updateArgs: ["update"],
    approxMb: 600,
    approxMinutes: [3, 8],
    changesSummary: "Adds its program under ~/.local/share/cursor-agent and links in ~/.local/bin. Leaves your shell files alone.",
    changes: [
      "Installs Cursor's agent under ~/.local/share/cursor-agent and links agent and cursor-agent in ~/.local/bin",
      "Does not edit your shell startup files; if ~/.local/bin is not on your PATH, it only tells you how to add it"
    ],
    passwordMoments: []
  };
}

// Which screen group each agent belongs to: the "operators" are always-on
// assistants (their own background service); the "coding" agents are the
// command-line tools you sign in to.
export const OPERATOR_AGENT_IDS = ["hermes", "openclaw"];
export const CODING_AGENT_IDS = ["claude", "codex", "cursor"];

export function agentGroup(agentId) {
  return CODING_AGENT_IDS.includes(agentId) ? "coding" : "operators";
}

const BUILDERS = {
  hermes: hermesRecipe,
  openclaw: openclawRecipe,
  claude: claudeRecipe,
  codex: codexRecipe,
  cursor: cursorRecipe
};

export function getInstallRecipe(agentId, platform = process.platform, arch = process.arch) {
  const builder = BUILDERS[agentId];
  if (!builder) throw new Error(`No install recipe for "${agentId}".`);
  return builder(platform, arch);
}
