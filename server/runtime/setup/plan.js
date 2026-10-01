// Turns a system check into the concrete list of steps "Set up everything"
// would run -- what's already there (kept, not reinstalled), what would be
// installed, and anything that can't proceed (unsupported, unreachable).
import { getInstallRecipe } from "./recipes.js";

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// An unrecognized host is treated as reachable: only a confirmed failure
// from the system check blocks a step, never a host system-check didn't probe.
function isHostReachable(check, hostname) {
  if (!hostname) return true;
  const entry = (check.network || []).find((item) => item.host === hostname);
  return entry ? entry.ok : true;
}

function macPasswordMoments(check) {
  if (check.os !== "darwin") return [];
  if (check.tools?.git?.found || check.tools?.brew?.found) return [];
  return ["macOS will open a window asking to install developer tools. Click Install (about 5 minutes)."];
}

// Only Hermes's installer needs git (to clone its repo); OpenClaw installs
// via npm and never touches git, so this is not computed for it.
function hermesLinuxManualStep(check) {
  if (check.os !== "linux" || check.tools?.git?.found) return null;
  const distro = check.linuxDistro;
  const id = String(distro?.id || "").toLowerCase();
  const idLike = String(distro?.idLike || "").toLowerCase();
  let command = "sudo apt-get install -y git build-essential curl xz-utils";
  if (id === "arch" || idLike.includes("arch")) {
    command = "sudo pacman -Sy --noconfirm git base-devel curl xz";
  } else if (["fedora", "rhel", "centos"].includes(id) || idLike.includes("fedora") || idLike.includes("rhel")) {
    command = "sudo dnf install -y git gcc gcc-c++ make curl xz";
  }
  return { agentId: "hermes", reason: "Git (and basic build tools) are missing.", command };
}

function installerCommandPreview(recipe) {
  const runner =
    recipe.shell === "powershell" ? "powershell.exe -NoProfile -ExecutionPolicy Bypass -File" : "/bin/bash";
  return `${runner} <installer downloaded to a temp file> ${recipe.args.join(" ")}`.trim();
}

export function buildSetupPlan(check, { agents = ["hermes", "openclaw"] } = {}) {
  const steps = [];
  const warnings = [];
  const manualSteps = [];
  const blocked = [];

  for (const agentId of agents) {
    const recipe = getInstallRecipe(agentId, check.os, check.arch);
    const detected = check.agents?.[agentId]?.detected;

    if (recipe.unsupportedReason) {
      steps.push({
        id: `${agentId}-skip-unsupported`,
        agentId,
        action: "skip-unsupported",
        title: `${recipe.label} is not supported on this computer`,
        description: recipe.unsupportedReason,
        changes: [],
        passwordMoments: [],
        default: false,
        sourceUrl: recipe.sourceUrl,
        commandPreview: null
      });
      continue;
    }

    if (detected?.installed) {
      steps.push({
        id: `${agentId}-keep`,
        agentId,
        action: "keep",
        title: `Keep ${recipe.label}${detected.version ? ` ${detected.version}` : ""}`,
        description: `${recipe.label} is already installed; nothing will be changed.`,
        changes: [],
        passwordMoments: [],
        default: true,
        sourceUrl: recipe.sourceUrl,
        commandPreview: null
      });
      steps.push({
        id: `${agentId}-update`,
        agentId,
        action: "update",
        title: `Update ${recipe.label}`,
        description: `Runs the official updater for ${recipe.label}.`,
        changes: [`Runs ${recipe.updateArgs.join(" ")} for the installed copy`],
        passwordMoments: [],
        default: false,
        sourceUrl: recipe.sourceUrl,
        commandPreview: `${detected.path} ${recipe.updateArgs.join(" ")}`
      });
      continue;
    }

    const installerHost = hostnameOf(recipe.installerUrl);
    if (!isHostReachable(check, installerHost)) {
      blocked.push({
        agentId,
        reason: `Could not reach ${installerHost}; check your internet connection and try again.`
      });
      continue;
    }

    if (agentId === "openclaw" && !check.tools?.node?.nodeOkForOpenClaw) {
      steps.push({
        id: "openclaw-prereq-node",
        agentId,
        action: "prereq-node",
        title: "Set up a Node 24 runtime for OpenClaw",
        description:
          "OpenClaw needs Node 24.16+ or 26.1+. A verified Node 24 build will be downloaded -- no Homebrew, winget, or admin password.",
        changes: ["Downloads Node 24 into ~/.agent-os/node (or %LOCALAPPDATA%\\AgentOS\\node on Windows), verified by SHA-256"],
        passwordMoments: [],
        default: true,
        sourceUrl: "https://nodejs.org",
        commandPreview: "Download and verify the official Node 24 build for this computer"
      });
    }

    const passwordMoments = agentId === "hermes" ? macPasswordMoments(check) : [];
    if (agentId === "hermes") {
      const manual = hermesLinuxManualStep(check);
      if (manual) manualSteps.push(manual);
    }

    steps.push({
      id: `${agentId}-install`,
      agentId,
      action: "install",
      title: `Install ${recipe.label}`,
      description: `Runs the official ${recipe.label} installer, unattended.`,
      changes: recipe.changes,
      passwordMoments,
      default: true,
      sourceUrl: recipe.sourceUrl,
      commandPreview: installerCommandPreview(recipe)
    });
  }

  return { steps, warnings, manualSteps, blocked };
}
