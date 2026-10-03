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
 * @property {SafetyAction[]} actions
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
 * @property {() => Array<Object>|null|Promise<Array<Object>|null>} [onOutputEnd] - called once when the output has ended; returns events
 *   built from everything parseLine collected (for output that only makes sense as a whole, like one JSON document)
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
 *   options is adapter-specific and set by trusted server code only (Hermes: talkOnly; OpenClaw: sessionId, model)
 * @property {(line: string, stream: "stdout"|"stderr", ctx?: Object) => Array<Object>|null} parseLine
 * @property {{status: (detected: DetectedAgent) => Promise<ServiceStatus>, start: (detected: DetectedAgent) => RunPlan, stop: (detected: DetectedAgent) => RunPlan}} [service]
 * @property {(actionId: string, detected: DetectedAgent) => RunPlan|null} [safetyAction] - builds the plan for a safetyStatus() action id
 */

export const ADAPTER_SHAPE_VERSION = 1;
