// OpenClaw's plan brains, read from the programs themselves (spec
// docs/superpowers/specs/2026-10-15-plan-brains-design.md, sections 2, 3 and 7):
// the plan status for the brain card, the plan model lists, and the model a
// request asks for, matched against the list read again here.
//
// Everything is read through OpenClaw's and Claude Code's own commands
// (`config get`, `models list`, `models auth list`, `models status`, `auth
// status`), never their files, and through runCommand only (output kept in
// memory, never written to a run log). `models auth list` leaves as each row's
// method and token sharing only (readChatgptAuth, in models.js); `models status
// --check` as its exit code only. Nothing here changes OpenClaw: jobs.js does that.
import { ADAPTERS } from "../agents/index.js";
import { runCommand } from "../safety.js";
import { OPENCLAW_MODEL_PATH, parseConfigText, parseJsonOutput, readChatgptAuth, readOpenclawModelsConfig } from "./models.js";
import { openclawVersionInfo } from "./openclaw-version.js";
import {
  FABLE_NOTE,
  INVALID_PLAN_MODEL,
  OPENCLAW_PLANS,
  PLAN_FALLBACK_MODELS,
  PLAN_MODELS_AS_OF,
  PLAN_MODEL_NAMES,
  PLAN_PROVIDER,
  PLAN_READ_TIMEOUT_MS,
  TYPED_MODEL_RE,
  claudeCliPinned,
  hasClaudeCliPin,
  isFableModel,
  planModelRows,
  planOfPrimary,
  readinessOf
} from "./openclaw-plan-rules.js";
import { signInStatus } from "./signin.js";

const CONFIG_GET_TIMEOUT_MS = 10 * 1000;

function planError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlan(plan) {
  if (!OPENCLAW_PLANS.includes(plan)) throw new TypeError('plan must be "claude" or "chatgpt"');
}

// A fresh detection every time (never the 30 s detect cache or the 60 s system
// check), so an OpenClaw updated a moment ago is seen at once.
async function openclawNow(detected) {
  return detected ?? ADAPTERS.openclaw.detect({ refresh: true });
}

// The two reads that tell which plan OpenClaw is on live in models.js (readAgentModel
// uses them too, and models.js must not import this module): `config get
// agents.defaults.models --json` (the per-model settings, where the claude-cli runtime
// pins live) and `models auth list` (whether Sign in with ChatGPT is saved; only each
// sign-in's method and token sharing are kept, and the output goes no further than that
// function). They are re-exported here under the same names.
export { readChatgptAuth, readOpenclawModelsConfig };

// Can OpenClaw use the ChatGPT plan right now? `models status --check --plain`
// makes no model call (it never gets the probe option); only its exit code is
// read, and its output is dropped here.
export async function readChatgptReadiness(detected) {
  if (!detected?.installed) return "not_ready";
  const result = await runCommand(detected.path, ["models", "status", "--check", "--plain"], PLAN_READ_TIMEOUT_MS);
  return readinessOf({ ok: result.ok, code: result.code, signal: result.signal });
}

async function readPrimary(detected) {
  const result = await runCommand(detected.path, ["config", "get", OPENCLAW_MODEL_PATH], CONFIG_GET_TIMEOUT_MS);
  return result.ok ? parseConfigText(result.stdout) : null;
}

// GET /api/setup/openclaw/plans: { version, claude, chatgpt } (spec section 7).
export async function readOpenclawPlans() {
  const [claude, detected] = await Promise.all([signInStatus("claude"), ADAPTERS.openclaw.detect({ refresh: true })]);
  const answer = {
    version: openclawVersionInfo(detected),
    claude: { installed: Boolean(claude.installed), status: claude.status, method: claude.method ?? null, note: claude.note },
    chatgpt: { signedIn: null, sharing: null, readiness: null }
  };
  if (!detected?.installed) return answer;
  const [auth, primary] = await Promise.all([readChatgptAuth(detected), readPrimary(detected)]);
  // The readiness check runs only while OpenClaw is on the ChatGPT plan, so the
  // card can say "expires soon" later.
  const readiness = planOfPrimary(primary, null, auth.signedIn) === "chatgpt" ? await readChatgptReadiness(detected) : null;
  answer.chatgpt = { signedIn: auth.signedIn, sharing: auth.sharing, readiness };
  return answer;
}

// GET /api/setup/openclaw/plan-models?plan=claude|chatgpt (spec sections 2, 3, 5, 7).
export async function readPlanModels(plan, { detected } = {}) {
  assertPlan(plan);
  const found = await openclawNow(detected);
  let rows = null;
  let modelsConfig = null;
  if (found?.installed) {
    const [list, config] = await Promise.all([
      runCommand(found.path, ["models", "list", "--provider", PLAN_PROVIDER[plan], "--json"], PLAN_READ_TIMEOUT_MS),
      plan === "claude" ? readOpenclawModelsConfig(found) : Promise.resolve(null)
    ]);
    rows = list.ok ? planModelRows(parseJsonOutput(list.stdout), plan) : null;
    modelsConfig = config;
  }
  const source = rows ? "account" : "fallback";
  const listed = rows ?? PLAN_FALLBACK_MODELS[plan].map((id) => ({ id, name: PLAN_MODEL_NAMES[id] }));
  // Before a first Claude plan onboard has written any claude-cli pin, every
  // model is offered (the Apply's runtime check still stops one that isn't pinned).
  const pinsExist = plan === "claude" && hasClaudeCliPin(modelsConfig);
  return {
    models: listed.map(({ id, name }) => ({
      id,
      name,
      note: isFableModel(id) ? FABLE_NOTE : null,
      available: pinsExist ? claudeCliPinned(modelsConfig, id) : true
    })),
    source,
    asOf: source === "fallback" ? PLAN_MODELS_AS_OF : null
  };
}

// The model id an Apply uses (spec section 5, "Model names from the person").
// The list is read again here, with the same code as plan-models: a name in it
// is accepted whatever its letter case, and the list's own spelling is used; any
// other name counts as typed and is accepted only while the list is the
// fallback (the only time the card offers "Type a model name").
export async function resolvePlanModel(plan, model, { detected } = {}) {
  assertPlan(plan);
  const text = typeof model === "string" ? model.trim() : "";
  if (text) {
    const { models, source } = await readPlanModels(plan, { detected });
    const lower = text.toLowerCase();
    const listed = models.find((entry) => entry.id.toLowerCase() === lower);
    if (listed) return listed.id;
    const prefix = `${PLAN_PROVIDER[plan]}/`;
    const typed = text.startsWith(prefix) ? text.slice(prefix.length) : text;
    if (source === "fallback" && TYPED_MODEL_RE.test(typed)) return typed;
  }
  throw planError("invalid_model_id", INVALID_PLAN_MODEL);
}
