# Plan brains for OpenClaw, and Hermes's own model picker (SP3 addition)

**Status:** design approved by the owner in chat on 2026-10-15 (flow diagram and card sketch). Revised the same day after a review (15 confirmed findings fixed) and the owner's decision that Hermes's picker opens in its own Terminal.app window. This document is binding for the tasks it adds to SP3 (see "Tasks"). It builds on `docs/superpowers/specs/2026-10-11-cobalt-redesign-and-real-terminals-design.md` (the "main spec"): its harness rules H1-H9, the Safety levels, the folder policy and the session engine of SP3 all apply unless this document says otherwise.

**Research behind it:** `.superpowers/subscription-brains/` (git-ignored): `findings.md`, `terms.md`, `openclaw.md`, `hermes.md`, `models.md`, `capabilities.md`, `handoff.md`, each with sources and dates, fact-checked on 2026-10-15.

## Goal

On the Agents page and in Setup, the person can give **OpenClaw** a brain from a plan they already pay for:
- **Claude plan**: OpenClaw runs the person's own signed-in Claude Code program;
- **ChatGPT plan**: OpenClaw signs in with OpenAI's official "Sign in with ChatGPT";

and pick the model from what their account offers. For **Hermes**, Agent OS adds nothing of its own: the brain card on the Agents page opens **Hermes's own model picker** (`hermes model`) in its own Terminal.app window and then shows what Hermes saved.

## Owner decisions (2026-10-15)

1. **Allowed routes only.** Agent OS itself sets up only the routes the vendors' terms clearly allow (see "Terms basis").
2. **OpenClaw's ChatGPT sign-in happens inside Agent OS,** in a small terminal panel on the brain card, using the terminal SP3 builds. The Claude plan uses the existing "Sign in to Claude Code" control (Claude Code's own `claude auth login`).
3. **Hermes:** nothing new is built for Hermes brains. "Choose in Hermes" opens Hermes's own picker (`hermes model`) in its own Terminal.app window, not in the card's terminal. The person picks anything Hermes offers there; the card reads what Hermes saved afterwards.
4. **OpenClaw:** the Claude plan and ChatGPT plan brains as designed below, each with a model list read from the account.

## Terms basis (assumption: Agent OS stays a free, open-source app that each person runs on their own computer with their own accounts)

- **Anthropic.**
  - Help article "Use the Claude Agent SDK with your Claude plan" (update dated 2026-10-07): subscribers may still use "the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits".
  - Claude Code legal and compliance page (code.claude.com/docs/en/legal-and-compliance, fetched 2026-10-15): developers may not "collect, store, or intermediate Claude.ai credentials or session tokens"; third-party developers may not route requests through Free, Pro or Max plan credentials "on behalf of their users"; and nothing stops an end user from "signing in to the unmodified Claude Code binary with their own Claude subscription".
  - Agent SDK overview page (code.claude.com/docs/en/agent-sdk/overview, fetched 2026-10-15): unless Anthropic approved it first, third-party developers may not "offer claude.ai login or rate limits for their products".
  - OpenClaw's `claude-cli` runtime runs the unmodified `claude` program. OpenClaw's Anthropic provider page (`providers/anthropic.md`, as recorded in `openclaw.md`) says it "never reads, persists, refreshes, selects, or forwards the native login tokens".
  - **What keeps this route allowed:** it is the person's own subscription; it runs on their own computer; it is ordinary individual use (the legal page says plan limits assume "ordinary, individual usage"); and Agent OS never offers claude.ai login itself. The person signs in with Claude Code's own `claude auth login` (Anthropic's own flow), and Agent OS never sees, routes or holds that login. Anthropic may enforce "without prior notice" and changed these rules three times in 2026, so the research rates the account risk low to moderate, and the card note says so (§2).
- **OpenAI** (Sign in with ChatGPT docs, DevDay 2026-09-29): eligible ChatGPT Plus and Pro users may run "AI workloads in your tools with their ChatGPT plan" in open-source tools and local personal projects; OpenClaw is a listed open-source partner. It needs OpenClaw 2026.9.7 or newer.
- **Never set up by Agent OS:** OpenClaw's `setup-token` / `paste-token` Claude sign-in (it stores the token); OpenClaw's Codex sign-in (`--method oauth`, `--device-code`); Hermes's Anthropic sign-in or its borrowed Claude Code login; Hermes's "ChatGPT or Codex Subscription" (Codex's own sign-in); and any flow where Agent OS reads, stores or forwards a sign-in token. Hermes's own picker, which "Choose in Hermes" opens in a Terminal.app window, may still offer some of these. Agent OS shows the two lines of §4 before opening it, never makes those routes easier, and nothing typed or shown in that window passes through Agent OS. If Agent OS is ever charged for or hosted, these routes must be checked again.

## How it works

### 1. A `setup` session kind (the in-card terminal, for OpenClaw's ChatGPT sign-in only)

The main spec's session engine gains a third kind next to `agent` and `update`:

- **What it runs:** exactly one argv, with the detected `openclaw` path, no shell, no extra options: `openclaw models auth login --provider openai --method siwc` (the official ChatGPT sign-in; it refuses to run without a real terminal, which is why it needs a session). Its action name is `openclaw-chatgpt-signin`.
- **Created only by** `POST /api/setup/openclaw/signin-terminal` (§7), never by `POST /api/sessions` or the New session dialog. It is refused when OpenClaw is older than 2026.9.7 or its version can't be read (§3).
- **Environment:** H2, like every session. **Working folder:** the person's HOME (the command works on OpenClaw's own config, not on a project folder), the one other exception to the folder policy.
- **A byte pipe that keeps nothing.** It can show a sign-in link and a one-time code. So its input goes straight to the PTY and is never parsed, logged or recorded; its output is never recorded (no asciicast); and its mirror is disposed as soon as the session ends, so no snapshot of an ended setup session is ever served.
- **No session folder.** A `setup` session lives in memory only: no `<AGENT_OS_HOME>/sessions/<id>/` folder, no `meta.json` and no recorder. So it never appears in `GET /api/recordings` or Runs, the quit path's "ended (Agent OS quit)" write and startup recovery skip it, and after it ends `GET /api/sessions/:id` answers 404 (the card treats a 404 as ended). `quitCheck()` leaves out `kind: "setup"`.
- **Limits:** not counted toward the 8 live sessions; not gated by the Safety level (Setup's configuration steps are not gated today); at most one `setup` session at a time (a second start gets 409 `setup_running` with the running session's id and action).
- **Not shown** as a Sessions tab, in Home's Orbit, in the menu's sessions count or in the quit question's list of agent sessions. `GET /api/sessions` lists it only with `kind=all`, like the `update` kind. Hold to stop all and quitting stop it like any session. It is never resumed.
- **Embedded** in the brain card (Agents page and Setup) with the same browser terminal (`SessionTerminal`, SP3 U2) and WebSocket protocol as the Sessions page, through the same `/api/sessions/:id/attach` WebSocket and its security checks. Links it prints open through the desktop opener allow list (the sign-in hosts `auth.openai.com`, `openai.com` and `chatgpt.com` are already on it); anything else is copied.
- **Finding it again.** On mount, the card asks `GET /api/setup/openclaw/signin-terminal` for the live setup session and reattaches to it. Leaving the page or reloading does not stop the session; the card reattaches on return. On 409 `setup_running` the card attaches to the returned `sessionId`.
- **Closing it.** The panel has a **Close** button. It stops the session (`POST /api/sessions/:id/stop`, with no confirm, because a sign-in has nothing to lose) and closes the panel.
- **When it ends.** While the panel is open, the card watches `onState` for `exited` and `onConnection` for `ended`, polls `GET /api/sessions/:id` every 5 s, and passes `ended` to `SessionTerminal`. Once the session has ended, the card closes the panel and reads the sign-in status again.
- **Notices inline.** `SessionTerminal` hands its sentences to `onNotice` and never shows them itself, so the card shows them in one line under the terminal (for example "Link copied. Open it in your browser.").

### 2. OpenClaw: "Claude plan"

- **Needs:** Claude Code installed and signed in with its own Claude sign-in. `signInStatus("claude")` (`server/runtime/setup/signin.js`, `claude auth status`) also returns `method`: the `authMethod` word when it is a key of `CLAUDE_METHOD_NOTE`, else null.
  - `claude.ai` or `oauth_token` (both are Claude Code's own sign-in, used by the unmodified binary): the model list and Apply show.
  - `api_key`, `api_key_helper` or `third_party`: the card says "Claude Code uses an API key or a cloud account, not your Claude plan, so OpenClaw would bill that instead." and offers no Apply.
  - Not installed: the card says "Install Claude Code first." with a link to Setup's Claude Code install, and shows no model list and no Apply. `POST /api/setup/openclaw/plan` answers 409 `plan_not_ready`.
  - Not signed in: the card shows the existing "Sign in to Claude Code" control instead of the model list.
  - Signed in but `method` is null (an older Claude Code that can't say how): the card says "Agent OS couldn't tell how Claude Code is signed in. Update Claude Code, then check again." and offers no Apply.
  - Known limit: Claude Code also reports a sign-in to an Anthropic Console account (API billing) as `claude.ai`, so this check can't tell that apart from a plan sign-in.
- **Risk tick.** `--accept-risk` is an acknowledgement given in the person's name, so the card shows OpenClaw's own security notice ("This bot can read files and run actions if tools are enabled. A bad prompt can trick it into doing unsafe things.") and today's OpenClaw risk tick with Setup's words ("I understand OpenClaw can act on this computer. Agent OS will switch it to ask before running commands."). Apply sends `acceptOpenClawRisk: true` only when it is ticked; otherwise the route answers 400 `openclaw_risk_not_accepted` and nothing runs. The flag only records that the person saw the notice (`wizard.securityAcknowledgedAt`); it grants no tool permission and no plugin consent.
- **Apply** (a configure job through `POST /api/setup/openclaw/plan`, with today's steps, in this order):
  1. `openclaw onboard --non-interactive --accept-risk --auth-choice anthropic-cli`, plus today's optional flags (`--skip-health`, `--skip-channels`, `--skip-skills`, `--skip-ui`, `--install-daemon` when listed), all checked first against `openclaw onboard --help`, as today;
  2. the existing `openclaw-safe-defaults` step (`tools.exec.mode` changes to `ask` only when it is `full` or unset, and is never loosened). It runs right after onboard and before the runtime check, so a job the runtime check stops still leaves the mode at `ask`;
  3. **the runtime check:** `openclaw config get agents.defaults.models --json` must show `agentRuntime.id: "claude-cli"` on `anthropic/<model>`, or on `anthropic/*` when that model has no entry with a runtime of its own. Otherwise the job stops here with "OpenClaw would use an Anthropic API key for this model, not your Claude plan." The check runs before `models set`, so OpenClaw is never left pointing at a model that would bill an API key;
  4. `openclaw models set anthropic/<model>`;
  5. today's `services` step;
  6. the existing say-hello check (`runHealthChecks`), skipped at Look only with today's sentence.
- **Model list:** `openclaw models list --provider anthropic --json`, read with the parser rules in §5. If the list cannot be read: a dated fallback list (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1, dated 2026-10-15) plus a "Type a model name" field, with the sentence "Agent OS couldn't read your account's model list, so this list may be out of date."
- **Models the runtime check would reject.** Once a first Claude plan onboard has written `claude-cli` pins, the same `openclaw config get agents.defaults.models --json` is read for the list too: a model with no `claude-cli` pin and no `anthropic/*` entry shows "Not available on your plan in this OpenClaw yet" and has no Apply (`available: false` in §7). Before any pin exists every model is offered, and the Apply's runtime check (step 3) still stops a model that turns out not to be pinned. S-B2 records which models OpenClaw really pins.
- **Fable costs extra.** Next to Fable 5.1 (and any other `claude-fable-` id), in the live list and in the fallback: "Uses usage credits: on Pro from the first request, on Max after half your weekly limit."
- **Card note:** "Shares your Claude plan limits with Claude Code. Anthropic allows this for personal use today, but has changed these rules several times this year."

### 3. OpenClaw: "ChatGPT plan"

- **Needs:** OpenClaw 2026.9.7 or newer. "New enough" is a semver-style compare of the numbers in OpenClaw's detected version line (for example `OpenClaw 2026.9.6 (eb377ac)` gives 2026.9.6), using `parseVersion` and `versionAtLeast` from `server/runtime/builders/resolve.js` (B1 exports them; today they are private to the module).
  - Older: the card says "Update OpenClaw first: its ChatGPT sign-in needs version 2026.9.7 or newer." with a link to Setup's existing OpenClaw update (which asks before downloading).
  - Unreadable: the card says "Agent OS couldn't read OpenClaw's version." with the same update link.
  - In both cases the card shows no Sign in button, and the server refuses the sign-in route (409 `openclaw_too_old` or 409 `openclaw_version_unknown`), so the card and the server agree.
- **Sign in:** "Sign in with ChatGPT" opens the `setup` session in the card (§1). The person approves in their browser.
- **Signed in?** `openclaw models auth list --provider openai --json` (read-only; it lists saved sign-ins without secret values). Signed in means a Sign in with ChatGPT token-sharing profile: on OpenClaw 2026.10.4 its id is `openai:token-sharing:<...>` (S-B3, 2026-10-16); a profile whose `method` is `siwc` (another version) counts too. Agent OS keeps only each profile's method and token sharing. E-mail, names and everything else are dropped, and the output is never logged or returned. S-B3 confirmed that no token value is printed.
- **Signed in, but plan use not allowed.** If the person granted only identity permissions, OpenClaw saves the account but can't use the plan. The card says "Signed in, but plan use isn't allowed yet. Sign in again and allow token sharing." (OpenClaw's code labels such a sign-in "Sign in with ChatGPT (Beta, identity only)". On 2026.10.4 it is not a token-sharing profile, so the card treats it as not signed in with ChatGPT and offers "Sign in with ChatGPT" again; the sentence above shows only for a version that reports token sharing as false. Not seen live.)
- **What S-B3 found (2026-10-16, OpenClaw 2026.10.4):** `models auth list --provider openai --json` is an object `{ agentDir, agentId, authStatePath, provider, profiles }`, and each profile is `{ id, provider, type, label, email, displayName, expiresAt }`, with no `method` and no `tokenSharing` field. B1 reads a token-sharing id (`openai:token-sharing:<...>`) as method `siwc` with sharing on; an explicit `method` or boolean `tokenSharing` (another version) still wins, and a bare array of rows is read the same way. The fakes answer in the 2026.10.4 shape (E3-F1).
- **Sign in again** (added at the owner's request during E3): when a ChatGPT plan Apply stops at the readiness step with "OpenClaw can't use your ChatGPT plan yet. Sign in again, and allow token sharing when ChatGPT asks.", the result offers "Sign in again", which starts the same in-card sign-in (§1) as "Sign in with ChatGPT".
- **Model list:** `openclaw models list --provider openai --json`, parser and fallback as in §2 (fallback: GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, dated 2026-10-15).
- **Apply** (a configure job through `POST /api/setup/openclaw/plan`, with the same risk tick as §2), in this order:
  1. `openclaw models set openai/<model>`;
  2. the existing `openclaw-safe-defaults` step;
  3. **readiness:** `openclaw models status --json` (changed after live check S-B3, 2026-10-16, in Task E3-F2; it replaced `models status --check --plain`, whose exit code judges the WHOLE model setup, not the ChatGPT sign-in: after the Claude plan's onboard the utility model is an anthropic one on the claude-cli runtime, which OpenClaw rates "indeterminate" without a call, so `--check` exited 1 although the ChatGPT sign-in was fine). Without `--probe` it makes no model call. The output is parsed in memory and only one answer word leaves ("ready", "not_ready" or "unknown"); it is never logged, saved, returned or put in an error. The read has one 15 s budget. It judges the `openai` provider alone:
     - not ready: there is no OAuth profile of provider `openai` whose id is a token-sharing one (`openai:token-sharing:...`); or every such profile is "missing"; or `openai` is in `auth.missingProvidersInUse`; or an `openai` entry in `auth.modelRouteIssues` is "incompatible" or "indeterminate". The job stops with "OpenClaw can't use your ChatGPT plan yet. Sign in again, and allow token sharing when ChatGPT asks.";
     - ignored: every other provider's issues, routes and profiles, `unusableProfiles`, and `auth.runtimeAuthRoutes` entirely (a runtime route `openai/codex` read "unavailable" while the ChatGPT hello worked);
     - ready otherwise. A token-sharing profile that reads "expiring" or "expired" is ready (renewed by OpenClaw): its access token lives about an hour, OpenClaw's own warning window is 24 hours, and OpenClaw renews it from its refresh token on the next use (its token-sharing OAuth runtime exports `refreshTokenSharingCredential`, a refresh_token grant), so "expires soon, sign in again" would be wrong for "expiring", and "can't use your plan yet" wrong for "expired". A live run (2026-10-16, 23:30) saw the profile and the `openai` OAuth provider read "expired" (about -57 minutes) an hour after the last use, with `openai` not in `auth.missingProvidersInUse` and no `openai` route issue; that it renews on the next use is from OpenClaw's code (no hello ran after that read). One usable profile is enough: "expired" plus "missing" is ready, and only all "missing" is not. The Apply's hello check is the real proof;
     - unknown: the read timed out, couldn't run, exited non-zero, or its output is not JSON or has an `auth` block without an OAuth profile list. The job goes on to the hello check with the warning "Agent OS couldn't check your ChatGPT sign-in. The hello check shows whether OpenClaw can use it." (at Look only, when no hello runs: "Agent OS couldn't check your ChatGPT sign-in, and Safety is on Look only, so no hello check runs to show whether OpenClaw can use it."). If that hello then fails, the earlier model is put back as below and the job fails on the hello step with "OpenClaw didn't answer on your ChatGPT plan, so Agent OS put its earlier model back." (without the second half when none could be put back);
     - an older OpenClaw whose JSON has no `auth` block at all keeps the old rule on the same budget: `models status --check --plain`, exit code only. Exit 0: ready. Exit 2: the job goes on, and the card shows "Your ChatGPT sign-in expires soon. Sign in again." Any other exit: not ready;
  4. the say-hello check.
- **A failed readiness check puts the old model back.** Before step 1 the job reads the current primary (`openclaw config get agents.defaults.model.primary`). If step 3 stops the job (or step 4's hello fails after an unknown readiness), it runs `openclaw models set <that primary>` again, so OpenClaw is never left on a ChatGPT model it can't use. If there was no primary, it leaves the new one and says so in the job's last line.
- The readiness check also runs for `GET /api/setup/openclaw/plans` while OpenClaw is on the ChatGPT plan, so the card can show "can't use your plan yet" later (and "expires soon" for an older OpenClaw only). An "unknown" answer shows no sentence and no Sign in button.
- **Card note:** "Shares your ChatGPT plan limits with Codex."

### 4. Hermes: "Choose in Hermes"

- The Hermes brain card (Agents page) keeps its existing buttons (Change model, Choose on OpenRouter, Change brain) and still shows the provider and model Hermes has saved, read with the existing `readAgentModel("hermes")` (`hermes config get ...`). It adds one button: **Choose in Hermes**.
- Next to the button, before anything opens, two quiet lines (honest, not a block):
  - "If you pick Anthropic without a Claude API key, Hermes uses your Claude Code sign-in (or its own Claude sign-in). Anthropic doesn't allow apps like Hermes to use Claude sign-ins this way: it's charged as usage credits, not your plan, it doesn't work on Pro, and it can sign Claude Code out. A Claude API key is fine."
  - "Hermes's 'ChatGPT or Codex Subscription' reuses Codex's own sign-in, which OpenAI hasn't documented for other apps. Hermes's official Sign in with ChatGPT isn't released yet."
- **What the button does:** `POST /api/setup/hermes/model-terminal` opens Hermes's picker in its own Terminal.app window through a helper split out of `openSignInInTerminal` (`server/runtime/setup/signin.js`), `openCommandInTerminal(binPath, args, { name, platform, spawnFn })`, which both callers use. The Hermes path comes from the Hermes adapter's `detect()`. It writes a small `.command` file holding only the one fixed command line `<detected hermes path> model`, opened with `open -a Terminal <file>`. Nothing from the request goes into it. Terminal.app runs it with the person's own shell and settings, so Hermes sees exactly what it sees in Terminal (H1, H2), and nothing typed or shown there passes through Agent OS.
  - On macOS the card then says "Terminal opened with Hermes's model picker. Choose there, then press Refresh."
  - On Windows and Linux the helper hands the command back instead, as it does for sign-in. The card says "Run this command in your own terminal, choose a model, then press Refresh." with the existing copy control (`SetupCommand`, "Copy the command").
  - On `spawn_failed` the card shows "Terminal didn't open. Run this command in your own terminal, choose a model, then press Refresh." with `SetupCommand`.
- **Reading the result.** `open` returns at once, so Agent OS can't tell when the Terminal window closes. The card reads `readAgentModel("hermes")` again whenever the Agent OS window gets focus and when the person presses **Refresh**. Agent OS changes nothing in Hermes's config itself.
- No `setup` session and no PTY is ever created for `hermes model`.
- **Add a sign-in in Hermes** (added at the owner's request during E3): beside Choose in Hermes, `POST /api/setup/hermes/auth-terminal` opens Hermes's own credential helper, bare `hermes auth` (its interactive helper; `hermes auth add` needs a provider), the same way: its own `.command` file with one fixed line, the same local-mode, confirm and not-installed answers, and no session. The card then says "Terminal opened with Hermes's sign-in helper. Add your sign-in there, then press Refresh."; on Windows and Linux "Run this command in your own terminal, add your sign-in there, then press Refresh."; on `spawn_failed` "Terminal didn't open. Run this command in your own terminal, add your sign-in there, then press Refresh." The two lines above apply to it too.

### 5. Labels, model names and messages

- **Labels come from a runtime check.** `readAgentModel("openclaw")` also reads `openclaw config get agents.defaults.models --json` (through OpenClaw's own command, parsed with `parseJsonOutput`, never the files) and returns `plan: "claude" | "chatgpt" | null`:
  - "Claude plan" when the primary is `anthropic/<model>` and that model's entry (or the `anthropic/*` entry, when the model has no entry with a runtime of its own) has `agentRuntime.id: "claude-cli"`. A primary with an `@profile` suffix is never labelled a plan.
  - "ChatGPT plan" when the primary is `openai/<model>` and the auth-list check (§3) shows a Sign in with ChatGPT profile.
  - Otherwise "Anthropic API key" for `anthropic/...` and "OpenAI" for `openai/...`.
  - The plan notes (§2, §3) appear only with a plan label. `AgentBrainCard`'s `PROVIDER_NAME` gains `claude-plan` and `chatgpt-plan` for the receipt line.
- **Model list parser.** It accepts an array or `{ models: [...] }`, takes the id from `key` or `id` and the name from `name`, and ignores unknown fields. It strips a leading `<provider>/` that matches the plan (`anthropic/` or `openai/`) and drops rows whose id carries another provider's prefix. A row with no name shows its raw id. Any other shape, an empty list or a failed command counts as "cannot be read" and shows the fallback. Names shown: the list's own name, else a fixed table for the fallback ids (`claude-opus-5-5` Opus 5.5, `claude-sonnet-5-5` Sonnet 5.5, `claude-haiku-5-5` Haiku 5.5, `claude-fable-5-1` Fable 5.1, `gpt-6.1-sol` GPT-6.1 Sol, `gpt-6-sol` GPT-6 Sol, `gpt-6-luna` GPT-6 Luna), else the raw id.
- **Model names from the person.** A typed model name must match `/^[a-z0-9][a-z0-9._:-]{0,99}$/` after the provider prefix (no slash; the server adds `anthropic/` or `openai/`); a picked name must be one of the ids in the list just served (account or fallback). The server tells them apart by reading the list again at Apply (the same code as `plan-models`): a name in that list is accepted as it is, whatever its letter case; a name not in it counts as typed, and a typed name is accepted only while the list is the fallback (the only time the card shows the "Type a model name" field). Anything else gets 400 `invalid_model_id` with "That doesn't look like a model name."
- **Say-hello fix lines.** `healthFixLine` (`server/runtime/setup/jobs.js`) checks `target.mode` first. For `claude-plan` and `chatgpt-plan`, in this order:
  - `/usage limit|limit reached|rate.?limit|\b429\b|quota/i` gives "Your plan's usage limit is used up. Try again after it resets."
  - `/not (logged|signed) in|\/login|\b401\b|unauthori[sz]ed|expired/i` gives "OpenClaw isn't signed in to your plan anymore. Sign in again."
  - today's network pattern gives "Couldn't reach Anthropic." (Claude plan) or "Couldn't reach OpenAI." (ChatGPT plan);
  - a timeout gives "The agent didn't answer within a minute. Try again.";
  - anything else gives today's last sentence, which names no provider.
  - The OpenRouter and Ollama sentences are never used for these modes, and `openrouter` and `ollama` keep today's order.

### 6. Where the controls go

- **Agents page, OpenClaw:** the Brain card (`AgentBrainCard`) gains a "Your plan" panel, a new `BrainPlanCard` holding Claude plan and ChatGPT plan. While OpenClaw is on a plan (§5's `plan` field), Change model opens that plan's model list in `BrainPlanCard`, not the OpenRouter picker.
- **Agents page, Hermes:** the card keeps its existing buttons and adds "Choose in Hermes" and "Add a sign-in in Hermes" with the two lines of §4.
- **Setup:** `SetupBrainPanel` shows `BrainPlanCard` as an OpenClaw-only third card, outside the per-agent ticks (it applies through its own route); its `Kind` stays as it is. `BrainResult` labels the new modes "Claude plan" and "ChatGPT plan" (never "Local") and never shows the OpenRouter hint for them.

### 7. Interfaces

Every new route sits behind `requireLocalMode` (`server/runtime/local-session.js`): outside local mode (the public demo and the admin-token public mode) it answers 404 `not_available`, like every sessions route.

- `GET /api/setup/openclaw/plans` answers `{ version, claude, chatgpt }`:
  - `version: { have: string | null, need: "2026.9.7", newEnough: boolean | null }` (null when the version can't be read);
  - `claude: { installed: boolean, status: "signed_in" | "not_signed_in" | "unknown", method: string | null, note: string }` (from `signInStatus("claude")`);
  - `chatgpt: { signedIn: boolean | null, sharing: boolean | null, readiness: "ready" | "expiring" | "not_ready" | "unknown" | null }` (null when it can't be read; `readiness` only while OpenClaw is on the ChatGPT plan).
- `GET /api/setup/openclaw/plan-models?plan=claude|chatgpt` answers `{ models: [{ id, name, note, available }], source: "account" | "fallback", asOf: "2026-10-15" | null }`. `id` has no provider prefix; `note` is the Fable sentence or null; `available` is false only for a Claude plan model the runtime check would reject (§2), else true.
- `POST /api/setup/openclaw/plan` with `{ plan: "claude" | "chatgpt", model, confirm: true, acceptOpenClawRisk: boolean }` answers a `SetupJob` whose OpenClaw target mode is `claude-plan` or `chatgpt-plan`. Refusals: 400 `confirm must be true`, 400 `invalid_model_id`, 400 `openclaw_risk_not_accepted`, 409 `plan_not_ready` (Claude Code not installed or not on its own Claude sign-in, or no ChatGPT sign-in), and today's answer while another job runs. `jobs.js` accepts the two new modes only from this route: `POST /api/setup/configure` keeps refusing them (`parseConfigureBody` and the configure path through `normalizeTarget` stay as they are).
- `POST /api/setup/openclaw/signin-terminal` with `{ confirm: true }` answers 201 `{ session: SessionSummary }`. Refusals: 400 `confirm must be true`, 409 `setup_running` with `{ sessionId, setupAction: "openclaw-chatgpt-signin" }`, 409 `openclaw_too_old`, 409 `openclaw_version_unknown`, 503 `pty_unavailable`.
- `GET /api/setup/openclaw/signin-terminal` answers `{ session: SessionSummary | null }` (the live setup session, or null).
- `POST /api/setup/hermes/model-terminal` with `{ confirm: true }` answers `{ opened: boolean, command: string, reason?: "copy" | "spawn_failed" }`, the same shape as `POST /api/setup/signin/:agentId/terminal`. Refusals: 400 `confirm must be true`, 400 `agent_not_installed` when Hermes isn't installed.
- Reused as they are: `GET /api/setup/agents/:agentId/model` (its answer gains `plan` for OpenClaw), `POST /api/sessions/:id/stop`, `GET /api/sessions/:id` and the `/api/sessions/:id/attach` WebSocket.
- **Client (`src/setupApi.ts`):** `BrainMode` and `SetupJob`'s target mode gain `"claude-plan" | "chatgpt-plan"`; `AgentModelInfo` gains `plan`; new functions `getOpenclawPlans()`, `getOpenclawPlanModels(plan)`, `applyOpenclawPlan(payload)`, `startOpenclawSignInTerminal()`, `getOpenclawSignInTerminal()` and `openHermesModelTerminal()`. Close uses U1's session client to stop the session.
- **Client (`src/sessionsApi.ts`):** `getSession(id)` (`GET /api/sessions/:id`; a 404 counts as ended).

## Safety (each item gets a test)

1. **No tokens and no agent files, a hard rule for everything Agent OS runs.** Agent OS's own code never reads, copies, stores or passes a sign-in token or code, and never puts one on a command line, in an environment variable or in a file. It reads agents' settings only through their own CLIs (`config get`, `auth status`, `auth list`), never their files, so it never opens `~/.claude`, `~/.codex`, `~/.openclaw` or `~/.hermes`. The one existing touch stays: `brain.js` checks that `~/.openclaw/openclaw.json` exists and reads nothing from it. Hermes's picker runs in Terminal.app, outside Agent OS. Test: the file-access spy from `test/setup-builders.test.js` runs over plan status, both model lists, both applies, the sign-in session's start and stop, and the Hermes launch: no recorded path matches `FORBIDDEN_PATH` except `~/.openclaw/openclaw.json`.
2. **Fixed commands only.** The `setup` session runs only `openclaw models auth login --provider openai --method siwc` (argv only, no shell); anything else is refused. The Hermes launch runs only `open -a Terminal <file>` with a file holding only `<hermes path> model`, and never creates a PTY session. Test: creating a `setup` session with any other argv is refused; the Hermes launch test checks the exact `open` argv and the file's content.
3. Never `setup-token`, `paste-token`, `--method oauth`/`--device-code` for OpenClaw, or any flag that bypasses an agent's own permissions. Test: the argv logs of every fake (for example `.fake-openclaw-record.jsonl`), over every flow of this feature, contain no `setup-token`, `paste-token`, `--token`, `--method oauth`, `--device-code`, `--dangerously-skip-permissions` or `--yolo`; `--accept-risk` appears only on `onboard`, and only when the tick was sent; a source scan of the new server modules finds none of those strings.
4. For the `setup` session and every command this feature runs, Agent OS never sets or overrides `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME` or OpenClaw's state and profile variables (`OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_HOME`, `OPENCLAW_AGENT_DIR`) (H1). Test: every fake's environment log shows HOME unchanged and none of the listed variables set.
5. The `setup` session is never recorded and keeps nothing: its input is a byte pipe (never parsed, logged or recorded), and its mirror is disposed when it ends. Tests: no cast file is written; no session folder or meta.json is written; `GET /api/recordings` never lists it; `POST /api/sessions/quit-check` leaves it out while it is live; the mirror's dispose ran at exit; an attach after the end is refused.
6. Applying either plan brain never leaves OpenClaw's `tools.exec.mode` at `full` or unset. Test: each plan applied to a fake whose mode is `full`, and to one where it is unset, asserts that `config set tools.exec.mode ask` ran; a fake already at `ask` is left as it is; and a Claude apply stopped by the runtime check still leaves the mode at `ask`.

## Testing

- **Fakes.** Configure-job and status tests extend the OpenClaw fake in `test/setup-brain.test.js` (`FAKE_OPENCLAW_CLI_SOURCE`, which already answers `onboard --help`, `onboard` and `models set`). Only the sign-in terminal program extends the W1 TUI fake (`test/fakes/tui-agent.mjs`). New knobs:
  - `FAKE_AGENT_VERSION` (read by both the setup-brain OpenClaw fake and W1's TUI fake for `--version`; the default stays older than 2026.9.7, so tests that start the sign-in set it): older than, equal to and newer than 2026.9.7, and an unreadable line;
  - `FAKE_CLAUDE_AUTH_JSON`, read by the fake `claude` (`FAKE_AGENT_CLI_SOURCE` in `test/setup-builders.test.js`, moved to `test/helpers/` so `test/setup-brain.test.js` can install it): `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party`, no `authMethod`, signed out;
  - `FAKE_OPENCLAW_MODELS_JSON`: a list, `{ models: [...] }`, rows without names, an unreadable shape, an empty list, a failure;
  - `FAKE_OPENCLAW_AUTH_JSON`: no profile, a `siwc` profile, one without token sharing, an API-key profile (rows carry an e-mail, so the tests can check it is dropped);
  - `FAKE_OPENCLAW_STATUS_EXIT`: 0, 1 or 2;
  - `FAKE_AGENT_STATE`: a file in the test HOME that `config get` reads and that `onboard` and `models set` write. It holds `agents.defaults.model.primary`, `agents.defaults.models` (with and without the `claude-cli` pin, and with a model entry that names another runtime) and `tools.exec.mode` (`full`, unset, `ask`).
  - `onboard ... --auth-choice anthropic-cli` writes the `claude-cli` pin for a fixed set of models, as 2026.9.6 does, and no `anthropic/*` entry.
  - `models auth login --provider openai --method siwc` prints an `https://auth.openai.com/` link and a code, waits for a typed line, writes a `siwc` row into the `FAKE_AGENT_STATE` file and exits 0; the OpenClaw fake's `models auth list` prints `FAKE_OPENCLAW_AUTH_JSON` when it is set, else the state file's rows.
  - Every fake logs whether `HOME` changed and whether `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME`, `XDG_CONFIG_HOME` or any `OPENCLAW_*` variable reached it (Safety 4).
  - `hermes model` is now only a Terminal.app launch, so no fake runs it. A test injects the spawn function and checks that exactly `open -a Terminal <file>` was requested, that the file holds only `<hermes path> model`, and that no PTY session was created.
- **Server tests:**
  - the `setup` kind: allowed argv only, HOME as its folder, never recorded, mirror disposed at exit, attach after the end refused, not counted, one at a time (409 `setup_running` with id and action), absent from `GET /api/sessions` without `kind=all` and from `POST /api/sessions/quit-check`, stopped by Hold to stop all and by quitting, refused on an older or unreadable OpenClaw version;
  - Apply for both plans: step order, the risk tick (400 without it, nothing run), the runtime check stopping before `models set`, safe defaults (Safety 6), the readiness answers (ready, not ready and unknown from `models status --json`, and an older OpenClaw's `--check` exits 0, 1 and 2), and a ChatGPT apply stopped at readiness, or failing its hello after an unknown readiness, setting the earlier primary back;
  - model lists with every fake shape and the fallback; prefixed `key` rows (`anthropic/<id>`, `openai/<id>`) are stripped and accepted, and rows with another provider's prefix are dropped; the Fable note; `available: false` for an unpinned Claude model once pins exist, and every model offered before any pin; typed names, accepted and refused; a picked id that is not in the list just served is refused;
  - status: every Claude method and its sentence, and Claude Code not installed (Apply answers 409 `plan_not_ready`); every auth-list state; the output of `auth list` and `models status` never logged or returned;
  - labels: pinned, not pinned (never "Claude plan"), pinned by the wildcard only, a model entry naming another runtime, an `@profile` suffix, a ChatGPT sign-in, an API key only;
  - `healthFixLine`: a table test of every mode (`openrouter`, `ollama`, `claude-plan`, `chatgpt-plan`) against every pattern, so a plan mode never gets an OpenRouter or Ollama sentence;
  - `POST /api/setup/configure` still refuses `claude-plan` and `chatgpt-plan`; every new route answers 404 `not_available` outside local mode;
  - each Safety item.
- **UI probes** for both cards and every state, with screenshots for the owner (decision Q32). Probes fake every non-terminal state in the browser with `page.route`, as `kindfilter.mjs` does: `GET /api/setup/openclaw/plans`, `GET /api/setup/openclaw/plan-models`, `POST /api/setup/openclaw/plan`, `GET /api/setup/agents/:agentId/model` and `POST /api/setup/hermes/model-terminal` (the `opened: true` and the `reason: "copy"` answers, and `reason: "spawn_failed"`). So no probe opens a real Terminal window. Only the signing-in, reload and Close states start the real setup session, against W1's fake, with `FAKE_AGENT_VERSION=2026.9.7` on the audit server.
  - Claude plan: Claude Code not installed, signed out, on an API key (sentence, no Apply), on a plan (list), a model not available on the plan (sentence, no Apply), list fallback, a typed name refused, risk tick not ticked (Apply off), applying, applied (label and note), stopped by the runtime check;
  - ChatGPT plan: update needed, version unreadable, signed out, signing in (panel open), a reload while signing in (the panel reattaches), Close (the panel closes and the session stops), signed in without token sharing, list, applied and ready, expires soon;
  - Hermes: the two lines next to "Choose in Hermes", the "Terminal opened" sentence, the copy command (Windows and Linux), the "Terminal didn't open" sentence, Refresh showing the new model, window focus showing the new model (the probe changes the stubbed model answer, then dispatches `focus` on the window);
  - Setup: the third card, and `BrainResult` with each plan label.

## Live checks on the owner's Mac (Task E3 "Plan brains live checks", after E2)

Task E2's rule forbids changing an agent's config or running an installer, and these checks do both. So they run as their own task with their own rule: each check is asked first; before it, the person running the check records the current model (`readAgentModel`); afterwards they offer to restore that model with the same commands. Nothing reads a credential file.

The checks:

- **S-B1:** update OpenClaw to 2026.9.7 or newer through Setup's OpenClaw update (it asks its own download question), then the ChatGPT sign-in in the card with the owner's account. No model is applied here.
- **S-B2:** `openclaw onboard --non-interactive --accept-risk --auth-choice anthropic-cli` end to end (never run before), then a Claude plan model applied. Record which models OpenClaw pins to `claude-cli`.
- **S-B3:** the real fields of `openclaw models list --json` (both providers) and `openclaw models auth list --provider openai --json` (which field names the sign-in method, how a sign-in without token sharing shows, and that no token value is printed), and the exit codes of `openclaw models status --check --plain` (found to judge the whole setup, so readiness now reads `models status --json`: §3, Apply step 3); and the real shape of `openclaw config get agents.defaults.models --json` and `agents.defaults.model.primary` after S-B2's onboard. Any field that differs from the fakes is fixed in B1's parsers and fakes before the work is called done.
- **S-B4:** "Choose in Hermes" opens Hermes's picker in Terminal.app, and the card shows the new model afterwards.

Order: S-B1 (update and sign-in); then S-B3's list, auth-list and status reads, right after that sign-in and before any apply; then a ChatGPT plan model applied; then S-B2, followed by S-B3's `config get` reads; then S-B4.

### Results (Task E3, 2026-10-16)

- S-B1: OpenClaw 2026.9.6 to 2026.10.4 through Setup's update (about 2.5 minutes; it asked nothing; Setup's log showed only OpenClaw's JSON at the end). The card's "Update in Setup" opened Setup at its first step, and Continue there skipped the plan step (follow-up). The ChatGPT sign-in in the card worked on the second try (the first one coincided with an internet drop on the owner's side): the program ran exactly `models auth login --provider openai --method siwc`, ended by itself after about 77 seconds, and Agent OS kept nothing (no session folder, no recording).
- S-B3, after the sign-in: `models list --provider openai --json` is an object `{ count, models }`, each row `{ key, name, available, contextTokens, contextWindow, input, local, tags }`; the Claude list is `{ count: 0, models: [] }` until OpenClaw's Claude onboard. `models auth list --provider openai --json` is an object `{ agentDir, agentId, authStatePath, provider, profiles }`; a ChatGPT sign-in is one profile `{ id, provider, type, label, email, displayName, expiresAt }` with no `method` and no `tokenSharing` field: its id `openai:token-sharing:<...>` names it (type "oauth", displayName "Sign in with ChatGPT (Beta)"). A sign-in without token sharing is labelled "Sign in with ChatGPT (Beta, identity only)" in OpenClaw's code (not seen live). No token value was printed. `models status --check --plain` exited 0 before the Claude onboard and 1 after it (it judges OpenClaw's whole model setup, and the claude-cli routes read "indeterminate"), and once ran past the 15-second limit. A token-sharing login reads "expiring" right after the sign-in and "expired" an hour after its last use; OpenClaw renews it from its refresh token.
- Approved change of order: none (the optional sign-in without token sharing, Step 8, was skipped).
- ChatGPT plan applied with gpt-6.1-sol: the first Apply stopped at the readiness check (exit 1, from the Claude routes) and put the earlier model back; the owner's next Apply succeeded: readiness ready, hello ok. Readiness now reads `models status --json` and judges only the openai part (E3-F2).
- S-B2: `openclaw onboard --non-interactive --accept-risk --auth-choice anthropic-cli` (with the skip flags OpenClaw lists) succeeded. OpenClaw pinned 11 `anthropic/<model>` refs to `claude-cli` (no `anthropic/*`) and made anthropic/claude-haiku-5-5 its utility model. Claude plan applied with claude-opus-5-5: ok, hello ok.
- S-B3, after onboard: `config get agents.defaults.models --json` is an object keyed by model ref; each pinned Claude entry is `{ agentRuntime: { id: "claude-cli" } }`, and two also carry an `alias`. `agents.defaults.model.primary` prints the plain ref (exit 0). With nothing set: not checked (OpenClaw had a model).
- S-B4: "Choose in Hermes" opened Hermes's picker in Terminal.app (macOS asked something the first time); the owner's own tab showed the new model on window focus, and the pane's card after Refresh. No session was made.
- Added at the owner's request during the checks: "Sign in again" on a ChatGPT plan result that stopped at the sign-in check, and "Add a sign-in in Hermes", which opens Hermes's own `hermes auth` helper in Terminal.app (08880a1).
- Also seen: the card's "Checking…" lasts about a minute while OpenClaw's reads run; the Configuration line's "Needs attention" comes from `openclaw status --json`, not from the plan checks; Hermes's card shows the provider "anthropic" in lower case.
- Differences from the fakes: the auth list (E3-F1, 2e2fef8), the readiness read (E3-F2, 23c4774), the model lists and `models-config` (E3-F3, 012cbd4).
- Fakes left as they are (orchestrator's ruling, 2026-10-17): the fake pins two Claude models (claude-opus-5-5, claude-fable-5-1) where the real onboard pinned 11, so the tests still see an unpinned model and keep exercising the Claude plan's pin step.

## Tasks (added to SP3)

| Id | Task | Needs first |
|---|---|---|
| B1 | Server: the `setup` kind for the OpenClaw sign-in, the routes of §7, the plan configure modes, status and model lists, labels, the health lines, the Hermes Terminal.app launch, the fakes and server tests | S10 |
| B2 | UI: `BrainPlanCard`, the Hermes card's "Choose in Hermes", Setup's third card, `BrainResult` labels, the probes | B1, U2, U4 |
| E3 | Plan brains live checks (S-B1 to S-B4) | E2 |

E1's verification also covers B1 and B2.

## Out of scope

Plan brains that Agent OS sets up for Hermes; running `hermes model` inside Agent OS's own terminal; OpenClaw's Codex-login (`--method oauth`, `--device-code`) route; Claude Max API credits set-up; any usage meter for operator brains; changes to builder brains (Claude Code, Codex, Cursor).

## Done when

- The OpenClaw card offers Claude plan and ChatGPT plan with live model lists (and the fallback), applies them with the safe defaults and the hello check, and shows a plan label and plan note only when the runtime check confirms the plan.
- The ChatGPT sign-in runs in the card's terminal, survives a reload, closes with Close, and keeps nothing after it ends.
- The Hermes card shows Hermes's saved model and the two lines, opens `hermes model` in Terminal.app (or hands back the command on Windows and Linux), and shows the new model after Refresh or window focus.
- A setup session is absent from the tabs, Orbit, the sessions count, the quit question, Runs' session recordings and startup recovery (it writes no session folder), and is stopped by Hold to stop all and by quitting.
- Every Safety item above has a passing test; the fakes cover every state; the probes pass and the screenshots are shown to the owner.
- The live checks S-B1 to S-B4 have run on the owner's Mac in Task E3 (or the owner deferred them).
