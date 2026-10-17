// The rules of OpenClaw's plan brains (docs/superpowers/specs/2026-10-15-plan-brains-design.md,
// sections 2, 3 and 5): which plan a model runs on, how the model lists and the
// sign-in lists are read, and every sentence the server says about plans.
//
// Pure: no imports and no I/O. The parsers take values that parseJsonOutput
// (models.js) has already parsed. The readers (openclaw-plans.js), the model
// answer (readAgentModel in models.js), the job runner (jobs.js) and the tests
// all use this one copy, so models.js and openclaw-plans.js never import each other.

export const OPENCLAW_PLANS = Object.freeze(["claude", "chatgpt"]);
export const PLAN_PROVIDER = Object.freeze({ claude: "anthropic", chatgpt: "openai" });
export const PLAN_MODE = Object.freeze({ claude: "claude-plan", chatgpt: "chatgpt-plan" });
export const PLAN_MODELS_AS_OF = "2026-10-15";
// `models list`, `models auth list` and `models status` may each take this long;
// `config get` keeps its own 10 s limit (CONFIG_GET_TIMEOUT_MS).
export const PLAN_READ_TIMEOUT_MS = 15000;

// Shown when the account's own list can't be read (dated: plans change).
export const PLAN_FALLBACK_MODELS = Object.freeze({
  claude: Object.freeze(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]),
  chatgpt: Object.freeze(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"])
});
export const PLAN_MODEL_NAMES = Object.freeze({
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-fable-5-1": "Fable 5.1",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6-luna": "GPT-6 Luna"
});

// A model name the person typed, after the provider prefix: no slash (the
// server adds anthropic/ or openai/), and it can never start with "-".
export const TYPED_MODEL_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/;

export const FABLE_NOTE = "Uses usage credits: on Pro from the first request, on Max after half your weekly limit.";
export function isFableModel(id) {
  return /^claude-fable-/i.test(String(id ?? ""));
}

// `claude auth status`'s authMethod words: Claude Code's own sign-in, and the
// ways that bill an API key or a cloud account instead of the plan.
export const CLAUDE_PLAN_METHODS = Object.freeze(["claude.ai", "oauth_token"]);
export const CLAUDE_API_METHODS = Object.freeze(["api_key", "api_key_helper", "third_party"]);

// An id from OpenClaw's own list, as it may go into `models set <provider>/<id>`:
// plain characters only, never a leading "-", a space, a slash or an "@" (in
// OpenClaw "@..." names an auth profile, which could pick another sign-in than
// the plan, and planOfPrimary never labels such a primary a plan).
const LISTED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_NAME_CHARS = 120;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function knownPlan(plan) {
  return typeof plan === "string" && Object.hasOwn(PLAN_PROVIDER, plan);
}

// `models list --provider <p> --json` -> [{ id, name }] with no provider
// prefix, or null when it can't be read (any other shape, or nothing usable).
export function planModelRows(value, plan) {
  if (!knownPlan(plan)) return null;
  const list = Array.isArray(value) ? value : plainObject(value) && Array.isArray(value.models) ? value.models : null;
  if (!list) return null;
  const prefix = `${PLAN_PROVIDER[plan]}/`;
  const seen = new Set();
  const rows = [];
  for (const row of list) {
    if (!plainObject(row)) continue;
    const raw = typeof row.key === "string" ? row.key : typeof row.id === "string" ? row.id : null;
    if (raw === null) continue;
    let id = raw.trim();
    if (id.startsWith(prefix)) id = id.slice(prefix.length);
    // Another provider's model (or an id that isn't plain) is never offered.
    if (!LISTED_ID_RE.test(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const own = typeof row.name === "string" ? row.name.trim().slice(0, MAX_NAME_CHARS) : "";
    rows.push({ id, name: own || (Object.hasOwn(PLAN_MODEL_NAMES, id) ? PLAN_MODEL_NAMES[id] : id) });
  }
  return rows.length ? rows : null;
}

function runtimeIdOf(entry) {
  return plainObject(entry) && plainObject(entry.agentRuntime) && typeof entry.agentRuntime.id === "string"
    ? entry.agentRuntime.id
    : null;
}

// `config get agents.defaults.models --json`: does any model run through
// Claude Code (the claude-cli runtime) yet?
export function hasClaudeCliPin(modelsConfig) {
  if (!plainObject(modelsConfig)) return false;
  return Object.values(modelsConfig).some((entry) => runtimeIdOf(entry) === "claude-cli");
}

// Would OpenClaw run anthropic/<id> through Claude Code (so on the Claude plan)?
// The model's own entry decides when it names a runtime; otherwise the
// "anthropic/*" entry does (spec section 2, step 3).
export function claudeCliPinned(modelsConfig, id) {
  if (!plainObject(modelsConfig) || typeof id !== "string" || !id) return false;
  const ownKey = `anthropic/${id}`;
  const own = Object.hasOwn(modelsConfig, ownKey) ? runtimeIdOf(modelsConfig[ownKey]) : null;
  if (own !== null) return own === "claude-cli";
  return Object.hasOwn(modelsConfig, "anthropic/*") && runtimeIdOf(modelsConfig["anthropic/*"]) === "claude-cli";
}

// signInStatus("claude") -> whether the Claude plan can be applied, and if not, why.
export function claudePlanReadiness({ installed, status, method } = {}) {
  if (!installed) return "not_installed";
  if (status === "not_signed_in") return "not_signed_in";
  if (CLAUDE_API_METHODS.includes(method)) return "api_billing";
  if (status !== "signed_in" || !CLAUDE_PLAN_METHODS.includes(method)) return "unknown_method";
  return "ready";
}

// `models auth list --provider openai --json` -> [{ method, sharing }], or null
// when it can't be read. Only each row's method and token sharing are kept:
// e-mail, names and everything else are dropped here.
// What live check S-B3 found on OpenClaw 2026.10.4: the answer is an object
// { agentDir, agentId, authStatePath, provider, profiles }, and a Sign in with
// ChatGPT leaves one profile row with the keys id, provider, type, label,
// email, displayName and expiresAt. It has no `method` and no `tokenSharing`
// field; the id "openai:token-sharing:<...>" is what names it (its type is
// just "oauth"). So a token-sharing id reads as method "siwc" with sharing on,
// and an explicit `method` or boolean `tokenSharing` (older or future
// versions) wins over it. The id's kind is the signal, never displayName or
// label: those are wording and may change or be translated. A sign-in without
// token sharing has not been seen live yet, so how it shows is unknown; such a
// row is treated as not signed in with ChatGPT, and the Apply's readiness
// check still catches a sign-in that can't use the plan. A bare array of rows
// (the earlier fakes' guess; no real version is known to print it) is read the
// same way.
export function parseAuthRows(value) {
  const list = Array.isArray(value) ? value : plainObject(value) && Array.isArray(value.profiles) ? value.profiles : null;
  if (!list) return null;
  const rows = [];
  for (const row of list) {
    if (!plainObject(row)) continue;
    if (row.provider !== undefined && row.provider !== "openai") continue;
    const tokenSharingProfile = isTokenSharingId(row.id);
    const method = typeof row.method === "string" ? row.method : tokenSharingProfile ? "siwc" : typeof row.type === "string" ? row.type : null;
    const sharing = typeof row.tokenSharing === "boolean" ? row.tokenSharing : tokenSharingProfile ? true : null;
    rows.push({ method, sharing });
  }
  return rows;
}

// OpenClaw names a ChatGPT token-sharing profile "openai:token-sharing:<...>":
// the second colon-separated segment of the id is the profile's kind.
function isTokenSharingId(id) {
  return typeof id === "string" && id.split(":")[1] === "token-sharing";
}

// Signed in with ChatGPT (method "siwc"), and whether token sharing was allowed.
export function chatgptSignIn(rows) {
  if (!Array.isArray(rows)) return { signedIn: null, sharing: null };
  const siwc = rows.filter((row) => row?.method === "siwc");
  if (!siwc.length) return { signedIn: false, sharing: null };
  const sharing = siwc.some((row) => row.sharing === true) ? true : siwc.some((row) => row.sharing === false) ? false : null;
  return { signedIn: true, sharing };
}

// `models status --check --plain`, from runCommand's answer: the exit code only.
// A timeout is { ok: false, code: 0, signal: "SIGTERM" }, which this reads as not ready;
// readChatgptReadiness answers "unknown" for a read that did not finish before it gets here.
// Since live check S-B3 (2026-10-16) this is only the answer for an OpenClaw whose
// `models status --json` has no auth block (readChatgptReadiness): 2026.10.4's
// `--check` judges the WHOLE model setup (default, fallbacks, image and utility
// model), not the ChatGPT sign-in alone. After the Claude plan's onboard its utility
// model is an anthropic one on the claude-cli runtime, which OpenClaw rates
// "indeterminate" without a call, so `--check` exits 1 although the ChatGPT sign-in
// is fine.
export function readinessOf(result) {
  if (result?.ok === true) return "ready";
  if (result && result.ok === false && result.code === 2 && !result.signal) return "expiring";
  return "not_ready";
}

// `models status --json` (OpenClaw 2026.10.4; it makes no model call), already
// parsed: can OpenClaw use the ChatGPT plan, judged on the openai provider alone?
//   "ready" / "not_ready"  the answer;
//   "unknown"              the output has an auth block but no oauth profile list
//                          (or is not an object at all): nothing can be judged;
//   null                   no auth block at all, an older OpenClaw: the caller falls
//                          back to `--check --plain` (readinessOf).
// Not ready: no oauth profile of provider "openai" whose id is a token-sharing one;
// or EVERY such profile is "missing"; or "openai" in missingProvidersInUse; or a model
// route issue of provider "openai" that is "incompatible" or "indeterminate".
// Everything else is IGNORED: other providers' issues, routes and profiles (anthropic
// on claude-cli reads "indeterminate"), unusableProfiles, and auth.runtimeAuthRoutes
// entirely (live check S-B3 saw openai/codex "unavailable" while the ChatGPT hello
// worked). A token-sharing profile "expiring" OR "expired" counts as ready: the access
// token lives about an hour and OpenClaw renews it from its refresh token on the next
// use (its token-sharing OAuth runtime exports refreshTokenSharingCredential, a
// refresh_token grant, and the auth-profile owner persists the rotation), so the
// status says "expired" an hour after every use; that renewal is from OpenClaw's
// code (no hello ran after the read below to show it live). Live run
// 2026-10-16, 23:30: OpenClaw on the ChatGPT plan, its hello answered an hour earlier,
// nothing used it since; `models status --json` gave the openai token-sharing profile
// "expired" (about -57 minutes) and the openai oauth provider "expired", openai NOT in
// missingProvidersInUse, no openai route issue. Calling that not ready would be a false
// alarm after every use; the Apply's hello check is the real proof. One usable profile
// is enough: "expired" plus "missing" is ready, only all "missing" is not. A sign-in
// without token sharing ("Sign in with ChatGPT (Beta, identity only)") has no
// token-sharing profile id, so it is "not signed in with sharing" and stays not ready.
export function chatgptReadinessOfStatus(value) {
  if (!plainObject(value)) return "unknown";
  const auth = value.auth;
  if (!plainObject(auth)) return null;
  const oauth = auth.oauth;
  if (!plainObject(oauth) || !Array.isArray(oauth.profiles)) return "unknown";
  const sharing = oauth.profiles.filter(
    (profile) => plainObject(profile) && profile.provider === "openai" && isTokenSharingId(profile.profileId)
  );
  if (!sharing.length) return "not_ready";
  if (sharing.every((profile) => profile.status === "missing")) return "not_ready";
  if (Array.isArray(auth.missingProvidersInUse) && auth.missingProvidersInUse.includes("openai")) return "not_ready";
  if (
    Array.isArray(auth.modelRouteIssues) &&
    auth.modelRouteIssues.some((issue) => plainObject(issue) && issue.provider === "openai" && (issue.kind === "incompatible" || issue.kind === "indeterminate"))
  ) {
    return "not_ready";
  }
  return "ready";
}

// Which plan OpenClaw's primary model runs on (spec section 5), or null.
export function planOfPrimary(primary, modelsConfig, signedInWithChatgpt) {
  if (typeof primary !== "string" || primary.includes("@")) return null;
  const slash = primary.indexOf("/");
  if (slash <= 0 || slash === primary.length - 1) return null;
  const provider = primary.slice(0, slash);
  const id = primary.slice(slash + 1);
  if (provider === "anthropic" && claudeCliPinned(modelsConfig, id)) return "claude";
  if (provider === "openai" && signedInWithChatgpt === true) return "chatgpt";
  return null;
}

// A `runCommand` answer for a read that never finished: it timed out or was
// stopped (a signal is set; a timeout is { ok: false, code: 0, signal: "SIGTERM" })
// or the program could not run (the code is a word such as "ENOENT", not a number).
// Such a read says nothing about the setting. A plain non-zero exit does not
// count here (OpenClaw may use one for "not set"; live check S-B3 settles it).
export function readDidNotFinish(result) {
  return Boolean(result?.signal) || typeof result?.code === "string";
}

// The provider label of OpenClaw's model answer; null for every other provider,
// which keeps today's label. `confirmed` is false when the read that would have
// confirmed a plan failed: Agent OS then doesn't know how the model is billed,
// so an anthropic/ model is just "Anthropic" (never "Anthropic API key").
export function openclawProviderLabel(provider, plan, confirmed = true) {
  if (provider === "anthropic") return plan === "claude" ? "Claude plan" : confirmed ? "Anthropic API key" : "Anthropic";
  if (provider === "openai") return plan === "chatgpt" ? "ChatGPT plan" : "OpenAI";
  return null;
}

// ---- what the server says (spec sections 2, 3 and 5; contract "User-visible sentences") ----

export const PLAN_NOT_READY_MESSAGE = Object.freeze({
  openclaw_missing: "Install OpenClaw first.",
  not_installed: "Install Claude Code first.",
  not_signed_in: "Sign in to Claude Code first, then try again.",
  api_billing: "Claude Code uses an API key or a cloud account, not your Claude plan, so OpenClaw would bill that instead.",
  unknown_method: "Agent OS couldn't tell how Claude Code is signed in. Update Claude Code, then check again.",
  chatgpt_signed_out: "Sign in with ChatGPT first, then try again."
});
export const RUNTIME_CHECK_FAILED = "OpenClaw would use an Anthropic API key for this model, not your Claude plan.";
// The reads before `models set` that couldn't be done: the job stops with
// nothing changed, so Apply can safely be tried again.
export const CURRENT_MODEL_UNREADABLE = "Agent OS couldn't read OpenClaw's current model, so it changed nothing. Try again.";
export const MODEL_SETTINGS_UNREADABLE = "Agent OS couldn't read OpenClaw's model settings, so it changed nothing. Try again.";
// OpenClaw's current model WAS read, but its name is not one Agent OS can put
// back later (it isn't a plain model reference). The job stops with nothing
// changed. Trying again can't help until the person switches OpenClaw to
// another model, so the sentence says that instead of "Try again".
export const CURRENT_MODEL_NOT_RESTORABLE =
  "OpenClaw's current model has a name Agent OS can't put back, so it changed nothing. Switch OpenClaw to another model first, then try again.";
export const CHATGPT_EXPIRING = "Your ChatGPT sign-in expires soon. Sign in again.";
export const CHATGPT_NOT_READY = "OpenClaw can't use your ChatGPT plan yet. Sign in again, and allow token sharing when ChatGPT asks.";
// The readiness read gave no answer (timed out, couldn't run, or unreadable): the job goes on
// to the hello check, which does show whether the plan works (live check S-B3, 2026-10-16).
// Two sentences, so each is true where the person reads it: a step's warnings are drawn after
// the agents' hello lines (not "below" them), the read may have failed without timing out
// (so no "in time"), and at Look only no hello check runs at all.
export const CHATGPT_READINESS_UNKNOWN = "Agent OS couldn't check your ChatGPT sign-in. The hello check shows whether OpenClaw can use it.";
export const CHATGPT_READINESS_UNKNOWN_LOOK_ONLY =
  "Agent OS couldn't check your ChatGPT sign-in, and Safety is on Look only, so no hello check runs to show whether OpenClaw can use it.";
// The hello check did not answer after a readiness that gave no answer: the job ends failed on
// the health step, like a readiness that says not ready (CHATGPT_NOT_READY), with the earlier
// model put back (the first sentence) or, when it could not be (none before, or `models set`
// failed; the step's warning says which), without that claim (the second).
export const CHATGPT_HELLO_FAILED_PUT_BACK = "OpenClaw didn't answer on your ChatGPT plan, so Agent OS put its earlier model back.";
export const CHATGPT_HELLO_FAILED = "OpenClaw didn't answer on your ChatGPT plan.";
export const INVALID_PLAN_MODEL = "That doesn't look like a model name.";
export const PLAN_JOB_INTERRUPTED = "Agent OS quit before this finished. Apply the plan again.";
export function noEarlierPrimary(ref) {
  return `OpenClaw had no model set before, so it keeps ${ref}.`;
}
// The say-hello fix lines for a plan brain (healthFixLine in jobs.js).
export const PLAN_HEALTH_LINES = Object.freeze({
  usageLimit: "Your plan's usage limit is used up. Try again after it resets.",
  signedOut: "OpenClaw isn't signed in to your plan anymore. Sign in again.",
  unreachable: Object.freeze({ "claude-plan": "Couldn't reach Anthropic.", "chatgpt-plan": "Couldn't reach OpenAI." }),
  timedOut: "The agent didn't answer within a minute. Try again."
});
