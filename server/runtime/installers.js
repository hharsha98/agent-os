import { execFile } from "node:child_process";

const INSTALL_RECIPES = {
  claude: {
    id: "claude",
    label: "Claude Code",
    command: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.anthropic.com/claude-code",
    manager: "npm",
    executable: "claude",
    safeAutoRun: true
  },
  codex: {
    id: "codex",
    label: "Codex",
    command: "npm install -g @openai/codex",
    docsUrl: "https://developers.openai.com/codex",
    manager: "npm",
    executable: "codex",
    safeAutoRun: true
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    command: "npm install -g @google/gemini-cli",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    manager: "npm",
    executable: "gemini",
    safeAutoRun: true
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    command: "npm install -g opencode-ai",
    docsUrl: "https://opencode.ai",
    manager: "npm",
    executable: "opencode",
    safeAutoRun: true
  },
  "firecrawl-builder": {
    id: "firecrawl-builder",
    label: "Open Agent Builder",
    command: "npm run builder:install",
    docsUrl: "https://github.com/firecrawl/open-agent-builder",
    manager: "npm-script",
    executable: "next",
    safeAutoRun: false
  },
  "elizaos-runtime": {
    id: "elizaos-runtime",
    label: "elizaOS Core",
    command: "npm install",
    docsUrl: "https://github.com/elizaOS/eliza",
    manager: "npm",
    executable: null,
    safeAutoRun: false
  },
  "provider-ollama": {
    id: "provider-ollama",
    label: "Ollama",
    command: "brew install ollama",
    docsUrl: "https://ollama.com/download",
    manager: "homebrew",
    executable: "ollama",
    safeAutoRun: false,
    note: "Install Ollama, run `ollama serve`, then save OLLAMA_HOST=http://127.0.0.1:11434."
  },
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    command: "npm install -g openclaw@latest",
    docsUrl: "https://github.com/openclaw/openclaw#install-recommended",
    manager: "npm",
    executable: "openclaw",
    safeAutoRun: true,
    note: "After installation, run `openclaw onboard --install-daemon` once to configure models, workspace, channels, and the Gateway."
  },
  openclaude: {
    id: "openclaude",
    label: "OpenClaude",
    command: "",
    docsUrl: "https://www.npmjs.com/package/openclaude",
    manager: "manual",
    executable: "openclaude",
    safeAutoRun: false,
    note: "The npm package name is reserved and not a real CLI. Configure OPENCLAUDE_CLI_PATH for a real compatible local tool."
  },
  hermes: {
    id: "hermes",
    label: "Hermes Agent",
    command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    executableCommand: {
      bin: "/bin/bash",
      args: ["-lc", "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"]
    },
    docsUrl: "https://github.com/NousResearch/hermes-agent#quick-install",
    manager: "official-script",
    executable: "hermes",
    safeAutoRun: true,
    note: "After installation, run `hermes setup` once to choose a model, tools, and gateway profile."
  }
};

export function getInstallRecipe(id) {
  return INSTALL_RECIPES[id] || null;
}

export function listInstallRecipes() {
  return Object.values(INSTALL_RECIPES);
}

function runInstall(recipe) {
  const [defaultBin, ...defaultArgs] = recipe.command.split(" ");
  const bin = recipe.executableCommand?.bin || defaultBin;
  const args = recipe.executableCommand?.args || defaultArgs;
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 120000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || "",
        code: error?.code ?? 0,
        signal: error?.signal ?? null
      });
    });
  });
}

export async function prepareInstall(id, { execute = false } = {}) {
  const recipe = getInstallRecipe(id);
  if (!recipe) {
    return {
      ok: false,
      id,
      mode: "not_found",
      message: `No install recipe registered for ${id}.`
    };
  }
  if (!recipe.command) {
    return {
      ok: true,
      id,
      mode: "manual",
      recipe,
      message: recipe.note || `${recipe.label} requires manual installation or path configuration.`
    };
  }
  const allowInstall = process.env.HERMES_AGENT_OS_ENABLE_INSTALL === "1";
  if (!execute || !allowInstall || !recipe.safeAutoRun) {
    return {
      ok: true,
      id,
      mode: "dry_run",
      recipe,
      message: `Install prepared. Run locally: ${recipe.command}${recipe.note ? ` Then: ${recipe.note}` : ""}`
    };
  }
  const result = await runInstall(recipe);
  return {
    ok: result.ok,
    id,
    mode: "executed",
    recipe,
    result,
    message: result.ok
      ? `${recipe.label} install command completed.${recipe.note ? ` ${recipe.note}` : ""}`
      : `${recipe.label} install command failed.`
  };
}
