// Adapter for the Codex CLI (`codex exec`). Facts are detected from
// --help/--version rather than hard-coded, because Codex releases
// frequently. Confirmed live against codex-cli 0.154.0's --help; see the
// deliverable report for any place the real CLI differed from the docs.
import {
  brainError,
  brainNotices,
  codexBrainArgs,
  keyHelper,
  normalizeBrain,
  runRecord
} from "../builders/brain-launch.js";
import { USAGE_LIMIT_TEXT, limitEvent } from "../builders/limits.js";
import { runCommand } from "../safety.js";
import {
  cachedFeatures,
  codexFallbackPaths,
  resolveBinary,
  runHelp,
  runVersion,
  splitVersion,
  withDetectCache
} from "./detect.js";

const LOGIN_STATUS_TIMEOUT_MS = 10 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

async function detectFeatures(binPath) {
  const [execHelp, topHelp] = await Promise.all([
    runHelp(binPath, ["exec", "--help"], 5000),
    runHelp(binPath, ["--help"], 5000)
  ]);
  const text = execHelp.text;
  return {
    json: /--json\b/.test(text),
    sandbox: /--sandbox\b/.test(text),
    cd: /--cd\b/.test(text),
    skipGitRepoCheck: /--skip-git-repo-check\b/.test(text),
    ephemeral: /--ephemeral\b/.test(text),
    // Only needed for a run on OpenRouter (-c, -m) or on a local model (--oss).
    config: /(^|[\s,])-c, --config\b/.test(text),
    model: /(^|[\s,])-m, --model\b/.test(text),
    oss: /--oss\b/.test(text) && /--local-provider\b/.test(text),
    // "If not provided as an argument (or if `-` is used), instructions are
    // read from stdin" in the Arguments section of `codex exec --help`.
    stdinDash: /is used\)/i.test(text) && /read from stdin/i.test(text),
    // `login` only shows up as a top-level command when `codex login status`
    // (a read-only check) actually exists.
    loginStatus: /\blogin\b[^\n]*manage login/i.test(topHelp.text)
  };
}

async function detect({ refresh = false } = {}) {
  return withDetectCache("codex", refresh, async () => {
    try {
      const binPath = await resolveBinary("codex", codexFallbackPaths());
      if (!binPath) {
        return {
          installed: false,
          path: "",
          version: "",
          features: {},
          error: "codex was not found on PATH."
        };
      }
      const versionText = await runVersion(binPath);
      const { version, versionFull } = splitVersion(versionText);
      const features = await cachedFeatures(`codex:${binPath}:${version}`, () => detectFeatures(binPath));
      return { installed: true, path: binPath, version, versionFull, features };
    } catch (error) {
      return { installed: false, path: "", version: "", features: {}, error: error?.message || "Codex detection failed." };
    }
  });
}

async function configStatus(detected) {
  if (!detected?.installed) {
    return { ok: false, summary: "Codex CLI is not installed.", problems: [], fixHint: "Install the Codex CLI, then refresh." };
  }
  if (!detected.features?.loginStatus) {
    return { ok: false, summary: "Codex login status is unknown.", problems: [], fixHint: "Run 'codex login', then refresh." };
  }
  // Never reads ~/.codex files: this only asks the CLI for its own status.
  const result = await runCommand(detected.path, ["login", "status"], LOGIN_STATUS_TIMEOUT_MS);
  const text = `${result.stdout}\n${result.stderr}`;
  if (/logged in/i.test(text) && !/not logged in/i.test(text)) {
    return { ok: true, summary: "Logged in to Codex.", problems: [] };
  }
  return {
    ok: false,
    summary: "Codex is not logged in.",
    problems: [],
    fixHint: "Run 'codex login', then refresh."
  };
}

async function safetyStatus() {
  return {
    permissive: false,
    summary: "Read-only sandbox by default; 'allow edits' switches to workspace-write for that run only.",
    actions: []
  };
}

// cwd is always the private run folder (see routes.js's makeRunDir); -C
// points Codex's own working root at the actual project directory instead.
async function buildRun({ prompt, cwd, detected, runDir, options = {} }) {
  const features = detected?.features || {};
  const allowEdits = options.allowEdits === true;
  const args = ["exec"];
  if (features.json) args.push("--json");
  if (features.sandbox) args.push("--sandbox", allowEdits ? "workspace-write" : "read-only");
  if (features.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (features.ephemeral) args.push("--ephemeral");
  args.push("--color", "never");
  if (features.cd) args.push("-C", cwd);

  // Which brain pays for the run. `plan` (the default) adds nothing, so the
  // command line is exactly what it always was. options.brain comes from
  // trusted server code (see builders/resolve.js). A new Codex session is
  // always used when a run moves to another brain: resuming across providers
  // can fail, so builders/continue.js hands the work over as a summary instead.
  const brain = normalizeBrain(options.brain, "codex");
  const notices = [];
  if (brain.mode !== "plan") {
    if (!(features.config && features.model && (brain.mode === "openrouter" || features.oss))) {
      throw brainError("brain_not_supported_by_cli", "This version of Codex can't be pointed at another model. Update Codex, then try again.");
    }
    args.push(...codexBrainArgs(brain, brain.mode === "openrouter" ? await keyHelper() : null));
    notices.push(...brainNotices("codex", brain));
  }

  let stdin;
  if (features.stdinDash) {
    args.push("-");
    stdin = prompt;
  } else {
    args.push("--", prompt);
  }

  const where = brain.mode === "openrouter" ? ", OpenRouter" : brain.mode === "local" ? ", local model" : "";
  const parserState = {}; // one per run, so a limit is reported once
  return {
    agentId: "codex",
    kind: "agent",
    title: `Codex exec (${features.stdinDash ? "stdin" : "argv"} transport, ${allowEdits ? "workspace-write" : "read-only"}${where})`,
    command: detected.path,
    args,
    cwd: runDir,
    stdin,
    timeoutMs: RUN_TIMEOUT_MS,
    ...runRecord({ prompt, cwd, brain, options }),
    ...(notices.length ? { notices } : {}),
    parseLine: (line, stream) => parseLine(line, stream, parserState)
  };
}

// Event shapes follow https://developers.openai.com/codex/noninteractive:
// thread.started once at start, item.started/updated/completed per work
// item, turn.completed with usage, and error.
// `ctx` is per-run memory (see buildRun) so a limit is reported once; called
// without one (as the tests do), every line is judged on its own.
function parseLine(line, _stream, ctx = {}) {
  // The plan limit as the agent prints it: {"type":"error","message":"You’ve hit
  // your usage limit..."} and/or {"type":"turn.failed","error":{"message":...}},
  // then exit 1 -- or, without --json, as a plain line.
  const limitFrom = (text) => {
    if (ctx.limitSeen || !USAGE_LIMIT_TEXT.test(String(text))) return [];
    ctx.limitSeen = true;
    return [limitEvent("codex")];
  };
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    const found = limitFrom(line);
    return found.length ? [{ type: "line", text: line }, ...found] : null;
  }
  if (!evt || typeof evt !== "object") return null;
  switch (evt.type) {
    case "thread.started":
      return [{ type: "system", text: `session started (thread ${evt.thread_id || "unknown"})` }];
    case "item.completed": {
      const item = evt.item || {};
      if (item.type === "agent_message") {
        return [{ type: "text", text: String(item.text ?? "") }];
      }
      if (item.type === "command_execution") {
        const exitCode = item.exit_code ?? item.exitCode ?? "?";
        return [{ type: "tool", text: `$ ${item.command ?? ""} (exit ${exitCode})` }];
      }
      if (item.type === "file_change") {
        const paths = Array.isArray(item.paths)
          ? item.paths.join(", ")
          : String(item.path ?? item.changes ?? "");
        return [{ type: "tool", text: `changed ${paths}` }];
      }
      return null;
    }
    case "turn.completed": {
      const usage = evt.usage || {};
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens;
      if (typeof inputTokens !== "number" && typeof outputTokens !== "number") return null;
      // Codex's JSONL has no cost field, so costUsd is left unset.
      return [{ type: "usage", inputTokens, outputTokens }];
    }
    case "error":
      return [{ type: "error", text: String(evt.message ?? "") }, ...limitFrom(evt.message ?? "")];
    case "turn.failed": {
      const message = String(evt.error?.message ?? "");
      return message ? [{ type: "error", text: message }, ...limitFrom(message)] : null;
    }
    default:
      return null;
  }
}

function safetyAction() {
  return null; // Codex has no configurable safety action yet.
}

export default {
  id: "codex",
  label: "Codex CLI",
  homepage: "https://openai.com/codex",
  docsUrl: "https://developers.openai.com/codex/noninteractive",
  license: "Proprietary",
  detect,
  configStatus,
  safetyStatus,
  buildRun,
  parseLine,
  safetyAction
};
