// Shared shape for a coding-agent adapter (Hermes, OpenClaw, and future
// additions). Nothing here spawns a process; adapters only describe what to
// run so the run manager (server/runtime/runs/run-manager.js) can validate
// and spawn it.

/**
 * @typedef {Object} DetectedAgent
 * @property {boolean} installed
 * @property {string} path - absolute path to the binary, "" when not found
 * @property {string} version - raw version string, "" when unknown
 * @property {Object<string, boolean>} features - feature flags found via --help
 * @property {string} [error] - present only when detection failed or nothing was found
 */

/**
 * @typedef {Object} ConfigStatus
 * @property {boolean} ok
 * @property {string} summary
 * @property {string[]} problems
 * @property {string} [fixHint]
 */

/**
 * @typedef {Object} SafetyAction
 * @property {string} id
 * @property {string} label
 * @property {string} [description]
 */

/**
 * @typedef {Object} SafetyStatus
 * @property {boolean} permissive
 * @property {string} summary
 * @property {SafetyAction[]} actions - fixes for something too open (each gets a "Fix" button)
 * @property {SafetyAction[]} [choices] - optional switches the person may turn on (a "Turn on" button); never a finding
 * @property {string[]} [notes] - calm facts about this safeguard, shown with an info mark
 */

/**
 * @typedef {Object} RunPlan - matches what runManager.startRun(plan) expects
 * @property {string} [agentId]
 * @property {"agent"|"service"} [kind]
 * @property {string} [title]
 * @property {string} command - absolute path
 * @property {string[]} args
 * @property {string} cwd - absolute, must already exist
 * @property {Object<string,string>} [env]
 * @property {string} [stdin]
 * @property {string[]} [redact]
 * @property {number} [timeoutMs]
 * @property {(line: string, stream: "stdout"|"stderr") => Array<Object>|null} [parseLine]
 * @property {(meta: Object) => Promise<void>} [onExit] - best-effort cleanup after the run ends
 * @property {string[]} [notices] - plain-English heads-ups recorded as `system` events right after "Started"
 * @property {(ending: {exitCode?: number|null, signal?: string|null}) => Array<Object>|null|Promise<Array<Object>|null>} [onOutputEnd] - called once when the output has ended; returns events
 *   built from everything parseLine collected (for output that only makes sense as a whole, like one JSON document, or
 *   a verdict that needs the exit code); `ending` is empty when the process could not be started
 * @property {{brain?: {mode: string, model: string|null}, task?: {cwd: string, allowEdits: boolean}, continuedFrom?: string}} [meta] -
 *   the few facts an adapter may put on its run's metadata (anything else is ignored)
 * @property {string} [taskPrompt] - the task text, kept in a private file next to the run so a run that stops at a plan limit can be continued
 */

/**
 * @typedef {Object} ServiceStatus
 * @property {boolean} running
 * @property {string} text - raw CLI output, for display
 */

/**
 * @typedef {Object} AgentAdapter
 * @property {string} id
 * @property {string} label
 * @property {string} homepage
 * @property {string} docsUrl
 * @property {string} license
 * @property {(opts?: {refresh?: boolean}) => Promise<DetectedAgent>} detect
 * @property {(detected: DetectedAgent) => Promise<ConfigStatus>} configStatus
 * @property {(detected: DetectedAgent) => Promise<SafetyStatus>} safetyStatus
 * @property {(input: {prompt: string, cwd: string, detected: DetectedAgent, runDir: string, options?: Object}) => Promise<RunPlan>} buildRun
 *   options is adapter-specific and set by trusted server code only (Hermes: talkOnly; OpenClaw: sessionId, model;
 *   Claude Code / Codex / Cursor: allowEdits, brain {mode, model, local?} from builders/resolve.js, and for continuing a
 *   run after a plan limit: originalPrompt, continuedFrom, and for Claude resume {sessionId, fork} and maxBudgetUsd)
 * @property {(line: string, stream: "stdout"|"stderr", ctx?: Object) => Array<Object>|null} parseLine
 * @property {{status: (detected: DetectedAgent) => Promise<ServiceStatus>, start: (detected: DetectedAgent) => RunPlan, stop: (detected: DetectedAgent) => RunPlan}} [service]
 * @property {(actionId: string, detected: DetectedAgent) => RunPlan|null|Promise<RunPlan|null>} [safetyAction] - builds the
 *   plan for an id from safetyStatus()'s `actions` or `choices` (the route runs an id only while one of them offers it;
 *   it awaits the answer, so an adapter may look things up first). The plan may carry a `then` plan (with a `note` line
 *   for the panel) that the route runs after the first one succeeds
 */

export const ADAPTER_SHAPE_VERSION = 1;
