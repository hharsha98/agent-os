// Turns a system check into the concrete list of steps "Set up everything"
// would run -- what's already there (kept, not reinstalled), what would be
// installed, and anything that can't proceed (unsupported, unreachable).
import { CODING_AGENT_IDS, OPERATOR_AGENT_IDS, agentGroup, getInstallRecipe } from "./recipes.js";

// Every agent a plan can cover, in screen order. The default plan stays the two
// operators; the coding agents are asked for by name (see routes.js, ?group=).
export const ALL_PLAN_AGENT_IDS = [...OPERATOR_AGENT_IDS, ...CODING_AGENT_IDS];

// Hermes is a git checkout, and `hermes update` can overwrite changes a person
// made in it. So its update step is offered only when the Hermes clean check
// (server/runtime/updates/hermes-clean.js) says the checkout is an unchanged
// official copy, and then it does not run as a job: Hermes may ask questions,
// so it runs in a terminal session the person can type into (`runsIn:
// "session"`, started through the update service). A job that names it is
// refused (jobs.js builds its own plan, which never holds it).

// What the Node step does, for the plan's "changes". The download is checked against the checksum list nodejs.org itself
// publishes (that catches a damaged download, not a tampered nodejs.org). The second sentence is true whenever that folder
// already holds a Node that is too old: Agent OS replaces the whole folder, and an agent installed inside it goes with it.
const MANAGED_NODE_CHANGES = [
  "Downloads Node 24 into ~/.agent-os/node (or %LOCALAPPDATA%\\AgentOS\\node on Windows), checked against the checksum nodejs.org publishes",
  "If Agent OS already has its own Node in that folder and it is too old, it is replaced. Agents installed inside Agent OS's own Node (for example Codex) are removed and need installing again."
];

// The facts every step carries so the screen can group it, name it and add up
// the size and time of what is ticked. Only installs have a size; Hermes and
// OpenClaw sizes were never measured, so theirs stay null instead of invented.
function stepMeta(recipe, { sized = false } = {}) {
  return {
    group: agentGroup(recipe.agentId),
    label: recipe.label,
    license: recipe.license,
    termsUrl: recipe.termsUrl || null,
    approxMb: sized ? recipe.approxMb ?? null : null,
    approxMinutes: sized ? recipe.approxMinutes ?? null : null
  };
}

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

// The Node build Setup downloads for OpenClaw or Codex (the same ≈30 MB the
// managed-node job logs while it works).
const NODE_DOWNLOAD_MB = 30;
const NODE_DOWNLOAD_MINUTES = [1, 2];

function installDescription(recipe) {
  if (recipe.npmPackage) return `Runs the official ${recipe.label} install (npm install -g ${recipe.npmPackage}) in your own folder.`;
  if (CODING_AGENT_IDS.includes(recipe.agentId)) {
    return `Downloads the official ${recipe.label} installer to a temporary file and runs it, instead of piping it into a shell.`;
  }
  return `Runs the official ${recipe.label} installer, unattended.`;
}

function installerCommandPreview(recipe) {
  // The coding agents carry the one-liner their vendor publishes, which is
  // what a person can paste into their own terminal.
  if (recipe.officialCommand) return recipe.officialCommand;
  const runner =
    recipe.shell === "powershell" ? "powershell.exe -NoProfile -ExecutionPolicy Bypass -File" : "/bin/bash";
  return `${runner} <installer downloaded to a temp file> ${recipe.args.join(" ")}`.trim();
}

// hermesClean: the cached answer of the Hermes clean check. Unknown or false (the default) offers no Hermes update.
// hermesUpToDate: the saved Hermes version row says "up-to-date" (default false). Then there is nothing to update (R48: Hermes
// would do nothing, or on a release channel move back), so the Hermes update step is left out as well. When that is the only
// reason (the copy is clean), the keep step is marked noUpdate: "up-to-date", so the page can say so instead of calling a clean
// copy "changed". A failed row, an available row and no row at all pass false: a check that failed blocks nothing.
export function buildSetupPlan(check, { agents = OPERATOR_AGENT_IDS, hermesClean = false, hermesUpToDate = false } = {}) {
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
        commandPreview: null,
        ...stepMeta(recipe)
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
        commandPreview: null,
        ...stepMeta(recipe),
        installedVersion: detected.version || "",
        ...(agentId === "hermes" && hermesClean === true && hermesUpToDate === true ? { noUpdate: "up-to-date" } : {})
      });
      if (agentId === "hermes" && (hermesClean !== true || hermesUpToDate === true)) continue;
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
        commandPreview: `${detected.path} ${recipe.updateArgs.join(" ")}`,
        ...stepMeta(recipe),
        ...(agentId === "hermes" ? { runsIn: "session" } : {})
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
        changes: [...MANAGED_NODE_CHANGES],
        passwordMoments: [],
        default: true,
        sourceUrl: "https://nodejs.org",
        commandPreview: "Download and verify the official Node 24 build for this computer",
        ...stepMeta(recipe),
        approxMb: NODE_DOWNLOAD_MB,
        approxMinutes: NODE_DOWNLOAD_MINUTES
      });
    }

    if (agentId === "codex" && !check.tools?.node?.nodeOkForCodex) {
      steps.push({
        id: "codex-prereq-node",
        agentId,
        action: "prereq-node",
        title: "Set up a Node 24 runtime for Codex",
        description:
          "Codex needs Node 22 or newer. A verified Node 24 build will be downloaded -- no Homebrew, winget, or admin password.",
        changes: [...MANAGED_NODE_CHANGES],
        passwordMoments: [],
        default: true,
        sourceUrl: "https://nodejs.org",
        commandPreview: "Download and verify the official Node 24 build for this computer",
        ...stepMeta(recipe),
        approxMb: NODE_DOWNLOAD_MB,
        approxMinutes: NODE_DOWNLOAD_MINUTES
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
      description: installDescription(recipe),
      changes: recipe.changes,
      passwordMoments,
      default: true,
      sourceUrl: recipe.sourceUrl,
      commandPreview: installerCommandPreview(recipe),
      summary: recipe.changesSummary || null,
      ...stepMeta(recipe, { sized: true })
    });
  }

  return { steps, warnings, manualSteps, blocked };
}
