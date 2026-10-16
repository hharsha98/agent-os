// "Your plan": OpenClaw's plan brains (spec docs/superpowers/specs/2026-10-15-plan-brains-design.md, sections 2, 3
// and 6), on OpenClaw's Brain card (Agents page) and as Setup's third AI brain card. Two sections:
//   Claude plan   OpenClaw runs the person's own Claude Code, signed in with Claude Code's own sign-in;
//   ChatGPT plan  OpenClaw signs in with OpenAI's "Sign in with ChatGPT", in a small terminal right here
//                 (PlanSignInTerminal: a session the server runs for OpenClaw's own sign-in command).
// A section that is ready lists the models the account offers (or a dated list with a "Type a model name" row), and
// its Apply starts the plan's job on the server, which also switches OpenClaw to ask before running commands and
// says hello. One security notice and one risk tick serve both Apply buttons; the tick is cleared after each job.
//
// Honesty: every state here is the server's answer (GET /api/setup/openclaw/plans), read from the agents' own
// commands; the server reads it all again when Apply is pressed, and its refusal sentence is shown as it is. No
// token, code or sign-in passes through this card.
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { ApiError } from "../../api";
import { navigateTo } from "../../nav";
import { stopSession } from "../../sessionsApi";
import type { OpenclawPlan, OpenclawPlansInfo, PlanModelList, SetupJob } from "../../setupApi";
import {
  applyOpenclawPlan,
  cancelSetupJob,
  friendlyError,
  getOpenclawPlanModels,
  getOpenclawPlans,
  getOpenclawSignInTerminal,
  getSetupJob,
  recallJobId,
  rememberJobId,
  startOpenclawSignInTerminal
} from "../../setupApi";
import { OPENCLAW_RISK_LABEL } from "../agentModelChange";
import { BRAIN_AGENT_LABEL, CONFIGURE_STEP_LABEL, type BrainAgentLine } from "../brainShared";
import { withTimeout } from "../homeShared";
import {
  CANCEL_UNSURE,
  CHATGPT_PLAN_WORDS,
  CLAUDE_PLAN_WORDS,
  FALLBACK_LIST_NOTE,
  MAY_HAVE_APPLIED,
  NOT_ON_PLAN_NOTE,
  OPENCLAW_SECURITY_NOTICE,
  PLAN_LABEL,
  PLAN_LIMITS_MS,
  PLANS_FOCUS_GAP_MS,
  SETUP_RUNNING_POLL_MS,
  TYPED_MODEL_CHOICE_LABEL,
  TYPED_MODEL_LABEL,
  UNREADABLE_WORDS,
  chatgptPlanState,
  claudePlanState,
  offersSignInAgain,
  planApplyModel,
  planProblem,
  signInAfterClose,
  signInLookupWait,
  takeJobAnswer,
  type ChatgptPlanState,
  type ClaudePlanState,
  type PlanSelection
} from "../planBrainsShared";
import { gotNoAnswer } from "../setupGroupShared";
import PlanSignInTerminal from "./PlanSignInTerminal";
import { BrainResult } from "./SetupBrainPanel";
import SetupInstallPanel from "./SetupInstallPanel";
import StatusMark from "./StatusMark";
import { useInterval } from "./useInterval";
import "../brain.css";

export interface BrainPlanCardProps {
  // Where it is shown: OpenClaw's Brain card on the Agents page, or Setup's AI brain step (a card of its own).
  where: "agents" | "setup";
  // The plan OpenClaw is on now (its own answer, spec section 5), or null. Setup passes null.
  currentPlan: OpenclawPlan | null;
  // A plan job ended: the page should read OpenClaw's model again.
  onChanged(): void;
  // Whether the card is on screen: false once its routes answered 404 not_available and it hid itself (spec section 7).
  // The Brain card then sends Change model to the OpenRouter picker, as before plan brains.
  onAvailable?(available: boolean): void;
}

export interface BrainPlanCardHandle {
  // Change model while OpenClaw is on a plan: bring that plan's model list into view and put the keyboard there.
  showModels(plan: OpenclawPlan): void;
}

type Read<T> = { state: "loading" } | { state: "ok"; value: T; stale: string } | { state: "error"; words: string } | { state: "off" };

const JOB_POLL_MS = 1000;
const OPENCLAW_LINE: BrainAgentLine[] = [{ id: "openclaw", label: BRAIN_AGENT_LABEL.openclaw, installed: true, configured: true }];

// Outside local mode (the public demo, the admin-token public mode) these routes answer 404 not_available (spec section 7).
function isNotAvailable(error: unknown) {
  return error instanceof ApiError && error.status === 404 && error.message === "not_available";
}

function hasCode(error: unknown, ...codes: string[]) {
  return error instanceof ApiError && codes.includes(error.message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const BrainPlanCard = forwardRef<BrainPlanCardHandle, BrainPlanCardProps>(function BrainPlanCard({ where, currentPlan, onChanged, onAvailable }, ref) {
  const baseId = useId();
  const [plans, setPlans] = useState<Read<OpenclawPlansInfo>>({ state: "loading" });
  const [lists, setLists] = useState<Partial<Record<OpenclawPlan, Read<PlanModelList>>>>({});
  const [selection, setSelection] = useState<Record<OpenclawPlan, PlanSelection>>({ claude: null, chatgpt: null });
  // What the person typed in each plan's "Type a model name" row: kept while lists are read again (never thrown away).
  const [typed, setTyped] = useState<Record<OpenclawPlan, string>>({ claude: "", chatgpt: "" });
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [busy, setBusy] = useState<OpenclawPlan | "signin" | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<OpenclawPlan, string>>>({});
  const [job, setJob] = useState<SetupJob | null>(null);
  const [jobError, setJobError] = useState("");
  // The live sign-in session shown in the ChatGPT section; `fresh` when the person just started it (it takes the keys).
  const [signin, setSignin] = useState<{ id: string; fresh: boolean } | null>(null);
  const [signinError, setSigninError] = useState("");
  // False once the card is gone: a late answer must not update a screen that is not there. The newest read wins.
  const alive = useRef(true);
  const plansGeneration = useRef(0);
  const plansAt = useRef(0);
  const listGeneration = useRef<Record<OpenclawPlan, number>>({ claude: 0, chatgpt: 0 });
  const pollBusy = useRef(false);
  // The id of the job that reached a final state on this card: no later answer about it counts (takeJobAnswer).
  const settledJob = useRef<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const cardTitle = useRef<HTMLHeadingElement>(null);
  const claudeTitle = useRef<HTMLHeadingElement>(null);
  const chatgptTitle = useRef<HTMLHeadingElement>(null);
  const chatgptSection = useRef<HTMLElement>(null);
  // The job whose result is on screen now, for signInAgain to tell whether the person left it while the sign-in started.
  const shownJob = useRef<SetupJob | null>(null);
  shownJob.current = job;
  const latestOnChanged = useRef(onChanged);
  latestOnChanged.current = onChanged;
  const latestOnAvailable = useRef(onAvailable);
  latestOnAvailable.current = onAvailable;

  // What each plan needs now. A failed read keeps the last good answer under a note (P26); where these routes do not
  // exist (404 not_available), the card hides itself. A failed read says it in the app's own words (planProblem:
  // the server's sentence, an unreadable answer, no answer in time, no answer), never new ones.
  const readPlans = useCallback(async () => {
    const mine = (plansGeneration.current += 1);
    plansAt.current = Date.now();
    try {
      const value = await withTimeout(getOpenclawPlans(), PLAN_LIMITS_MS.plans);
      if (!alive.current || mine !== plansGeneration.current) return;
      if (!value?.version || !value.claude || !value.chatgpt) throw new Error(UNREADABLE_WORDS);
      setPlans({ state: "ok", value, stale: "" });
    } catch (error) {
      if (!alive.current || mine !== plansGeneration.current) return;
      if (isNotAvailable(error)) {
        setPlans({ state: "off" });
        return;
      }
      const words = planProblem(error, friendlyError);
      setPlans((current) => (current.state === "ok" ? { ...current, stale: words } : { state: "error", words }));
    }
  }, []);

  const readList = useCallback(async (plan: OpenclawPlan) => {
    const mine = (listGeneration.current[plan] += 1);
    setLists((current) => (current[plan]?.state === "ok" ? current : { ...current, [plan]: { state: "loading" } }));
    try {
      const value = await withTimeout(getOpenclawPlanModels(plan), PLAN_LIMITS_MS.models);
      if (!alive.current || mine !== listGeneration.current[plan]) return;
      if (!value || !Array.isArray(value.models)) throw new Error(UNREADABLE_WORDS);
      setLists((current) => ({ ...current, [plan]: { state: "ok", value, stale: "" } }));
    } catch (error) {
      if (!alive.current || mine !== listGeneration.current[plan]) return;
      const words = planProblem(error, friendlyError);
      setLists((current) => {
        const before = current[plan];
        return { ...current, [plan]: before?.state === "ok" ? { ...before, stale: words } : { state: "error", words } };
      });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void readPlans();
    // A ChatGPT sign-in left waiting (another page, a reload, another window) is found again (spec section 1). A
    // sign-in the person started meanwhile is never replaced by this late answer.
    withTimeout(getOpenclawSignInTerminal(), PLAN_LIMITS_MS.signInLookup)
      .then((answer) => {
        const session = answer?.session;
        if (alive.current && session && session.status !== "exited") setSignin((current) => current ?? { id: session.id, fresh: false });
      })
      .catch(() => undefined);
    // A plan job this tab started is picked up again: a running one is followed, a failed one is shown (it may say
    // Agent OS quit before it finished), and a finished or unknown one is forgotten. A question that got no answer is
    // not a reason to forget it.
    const id = recallJobId("plan");
    if (id) {
      withTimeout(getSetupJob(id), PLAN_LIMITS_MS.action)
        .then((found) => {
          if (!alive.current) return;
          if (found.status === "running" || found.status === "failed") setJob(found);
          else rememberJobId("plan", null);
        })
        .catch((error) => {
          if (!gotNoAnswer(error)) rememberJobId("plan", null);
        });
    }
    return () => {
      alive.current = false;
    };
  }, [readPlans]);

  // OpenClaw may have been updated, or Claude Code signed in, while the person was in another window (Review Focus 1).
  useEffect(() => {
    function onFocus() {
      if (Date.now() - plansAt.current < PLANS_FOCUS_GAP_MS) return;
      void readPlans();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [readPlans]);

  // Where the plan routes do not exist the card hides itself (below); the Brain card is told, so its Change model never
  // points at a list that is not there.
  const hidden = plans.state === "off";
  useEffect(() => {
    latestOnAvailable.current?.(!hidden);
  }, [hidden]);

  const info = plans.state === "ok" ? plans.value : null;
  const claudeState = info ? claudePlanState(info.claude) : null;
  const chatgptState = info ? chatgptPlanState(info) : null;
  // OpenClaw too old for the ChatGPT sign-in, or its version unreadable: the section shows that note and no Sign in.
  const versionBlocked = chatgptState === "too_old" || chatgptState === "version_unknown";

  // A refused Sign in (409 openclaw_too_old or openclaw_version_unknown) makes the card read the plans again, and
  // the section's note then says the same sentence: the refusal's own line goes, so it is never shown twice and
  // never comes back once OpenClaw has been updated.
  useEffect(() => {
    if (versionBlocked) setSigninError("");
  }, [versionBlocked]);

  // A section's model list is read once it is ready.
  useEffect(() => {
    if (claudeState === "ready" && !lists.claude) void readList("claude");
    if (chatgptState === "ready" && !lists.chatgpt) void readList("chatgpt");
  }, [claudeState, chatgptState, lists.claude, lists.chatgpt, readList]);

  // A job that ended may have changed OpenClaw's model, its pins or the sign-in: read everything again.
  function jobEnded() {
    latestOnChanged.current();
    setLists({});
    void readPlans();
  }

  // The controls that had the keyboard are about to go (Apply gives way to the job's steps, Cancel to the result): the
  // keyboard moves to the card's title, which stays through every state. Only when it was in the card or nowhere,
  // never away from something else the person moved to meanwhile (P26). Called before the state changes, while the
  // old controls are still there to be found.
  function keepKeysInCard() {
    const active = document.activeElement;
    if (!active || active === document.body || Boolean(root.current?.contains(active))) cardTitle.current?.focus();
  }

  // An answer about the job, from the poll or from Cancel. Once the job reached a final state on this card, no later
  // answer about it counts, so a poll answer that was already on its way when Cancel finished (or the reverse) never
  // runs jobEnded a second time, and never brings a job back that the person has already left.
  function takeJob(next: SetupJob) {
    const kind = takeJobAnswer(settledJob.current, next);
    if (kind === "ignore") return;
    if (kind === "final") {
      settledJob.current = next.id;
      keepKeysInCard();
    }
    setJob(next);
    if (kind === "final") jobEnded();
  }

  useInterval(
    async () => {
      if (!job || pollBusy.current) return;
      pollBusy.current = true;
      try {
        const next = await withTimeout(getSetupJob(job.id), PLAN_LIMITS_MS.action);
        if (!alive.current) return;
        takeJob(next);
      } catch {
        // a passing failure; the next tick asks again
      } finally {
        pollBusy.current = false;
      }
    },
    job && job.status === "running" ? JOB_POLL_MS : null
  );

  useImperativeHandle(
    ref,
    () => ({
      showModels(plan: OpenclawPlan) {
        const target = (plan === "claude" ? claudeTitle.current : chatgptTitle.current) ?? cardTitle.current;
        target?.scrollIntoView({ block: "center" });
        target?.focus();
      }
    }),
    []
  );

  function choose(plan: OpenclawPlan, next: PlanSelection) {
    setSelection((current) => ({ ...current, [plan]: next }));
    setErrors((current) => ({ ...current, [plan]: undefined }));
  }

  async function recheck() {
    if (rechecking) return;
    setRechecking(true);
    setLists({});
    await readPlans();
    if (alive.current) setRechecking(false);
  }

  async function apply(plan: OpenclawPlan) {
    const list = lists[plan];
    const { model } = planApplyModel(list?.state === "ok" ? list.value : null, selection[plan], typed[plan], plan);
    if (!model || !riskAccepted || busy !== null || job) return;
    setBusy(plan);
    setErrors({});
    try {
      const started = await withTimeout(applyOpenclawPlan({ plan, model, acceptOpenClawRisk: riskAccepted }), PLAN_LIMITS_MS.apply);
      if (!started || typeof started.id !== "string" || !Array.isArray(started.steps)) throw new Error(UNREADABLE_WORDS);
      // The server has the job whether or not this card is still on screen, so its id is always kept.
      rememberJobId("plan", started.id);
      if (!alive.current) return;
      setRiskAccepted(false);
      setJobError("");
      keepKeysInCard();
      setJob(started);
    } catch (error) {
      if (!alive.current) return;
      const words = planProblem(error, friendlyError);
      setErrors({ [plan]: gotNoAnswer(error) ? `${words} ${MAY_HAVE_APPLIED}` : words });
      // The server read the sign-in again and refused: what the card shows is out of date (Review Focus 3).
      if (hasCode(error, "plan_not_ready")) void readPlans();
      // The list changed since it was shown.
      if (hasCode(error, "invalid_model_id")) void readList(plan);
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function cancelJob() {
    if (!job) return;
    try {
      const next = await withTimeout(cancelSetupJob(job.id), PLAN_LIMITS_MS.action);
      if (!alive.current) return;
      takeJob(next);
    } catch (error) {
      if (!alive.current) return;
      const words = planProblem(error, friendlyError);
      setJobError(gotNoAnswer(error) ? `${words} ${CANCEL_UNSURE}` : words);
    }
  }

  // Back to the plans: the job is forgotten and the tick is cleared, so a new Apply asks again.
  function leaveResult() {
    rememberJobId("plan", null);
    setJob(null);
    setJobError("");
    setErrors({});
    setRiskAccepted(false);
  }

  function backToPlans() {
    leaveResult();
    // The result's buttons are gone: keep the keyboard on the card.
    cardTitle.current?.focus();
  }

  // After a 409 setup_running (another window, or a start still in progress) the running session is asked for every
  // second, up to `waitMs`; request() keeps only an error's code and sentence, not its sessionId.
  async function findSignInSession(waitMs: number): Promise<string | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const answer = await withTimeout(getOpenclawSignInTerminal(), PLAN_LIMITS_MS.signInLookup);
        const session = answer?.session;
        if (session && session.status !== "exited") return session.id;
      } catch {
        // asked again below
      }
      if (!alive.current || Date.now() + SETUP_RUNNING_POLL_MS > deadline) return null;
      await sleep(SETUP_RUNNING_POLL_MS);
    }
  }

  async function startSignIn() {
    if (busy !== null) return;
    setBusy("signin");
    setSigninError("");
    try {
      const answer = await withTimeout(startOpenclawSignInTerminal(), PLAN_LIMITS_MS.action);
      if (!alive.current) return;
      if (!answer?.session?.id) throw new Error(UNREADABLE_WORDS);
      setSignin({ id: answer.session.id, fresh: true });
    } catch (error) {
      if (!alive.current) return;
      // A sign-in already open (409), or a start whose answer never came (it timed out, and the server may have started
      // it all the same): ask for the running one every second, for up to 15 s, and attach to it if it appears.
      const wait = signInLookupWait(error);
      if (wait !== null) {
        const found = await findSignInSession(wait);
        if (!alive.current) return;
        if (found) {
          setSignin({ id: found, fresh: true });
          return;
        }
      }
      // The server checked OpenClaw's version again and refused: what the card shows is out of date.
      if (hasCode(error, "openclaw_too_old", "openclaw_version_unknown")) void readPlans();
      setSigninError(planProblem(error, friendlyError));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  // "Sign in again" on the result of a ChatGPT plan job that stopped at its sign-in check: the same sign-in as
  // "Sign in with ChatGPT" (startSignIn, no second path), and then the result is left exactly as Back to the plans
  // leaves it, so the terminal (or the refusal's own sentence) is in the ChatGPT section. The result stays on screen
  // while the sign-in starts, so its button can say "Starting…"; and it is only left if it is still the one shown (the
  // person may have pressed Done meanwhile, and a second Back would clear what they did since). The start can take
  // many seconds, so the keyboard moves to the card's title only when it is still in the card or nowhere (P26), never
  // away from a field the person went to meanwhile (the terminal takes it itself when the sign-in opens).
  async function signInAgain() {
    if (busy !== null || !job) return;
    const resultId = job.id;
    await startSignIn();
    if (!alive.current || shownJob.current?.id !== resultId) return;
    keepKeysInCard();
    leaveResult();
  }

  // The sign-in ended (it finished, Ctrl+C in the terminal ended it, or Close stopped it): close the panel and read
  // the sign-in again (spec section 1). The keyboard moves to the ChatGPT heading when it was in the panel (or
  // nowhere), never away from elsewhere; so a keyboard user who left the terminal with Ctrl+C lands there.
  const signinOver = useCallback(() => {
    const active = document.activeElement;
    const keepFocus = !active || active === document.body || Boolean(chatgptSection.current?.contains(active));
    setSignin(null);
    void readPlans();
    if (keepFocus) chatgptTitle.current?.focus();
  }, [readPlans]);

  // Close stopped the sign-in (or found it already gone): the panel closes as for an end, then the card asks once for
  // the live sign-in, so one started meanwhile (from another window) is shown here, not left out of sight. The
  // session just closed is never shown again, even while its stop is still finishing; a sign-in the person started
  // meanwhile is never replaced. What happens to the sign-in found is signInAfterClose's rule: when Close's stop
  // answered 404 (`gone`), the session was not live, and a sign-in still before its spawn answers that too (Task B1a
  // carry-forward), so that same session is stopped, not shown; a different session is another window's, which is
  // left running and shown. A stop that fails leaves it running, so it is shown instead of being lost from sight.
  const closedSignIn = useCallback(
    (closedId: string, gone: boolean) => {
      signinOver();
      withTimeout(getOpenclawSignInTerminal(), PLAN_LIMITS_MS.signInLookup)
        .then(async (answer) => {
          const next = signInAfterClose(closedId, gone, answer?.session);
          const stopId = next.stop;
          if (stopId) {
            try {
              await stopSession(stopId);
              return;
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) return;
            }
          }
          const showId = stopId ?? next.show;
          if (showId && alive.current) setSignin((current) => current ?? { id: showId, fresh: false });
        })
        .catch(() => undefined);
    },
    [signinOver]
  );

  if (plans.state === "off") return null;

  const Title = where === "setup" ? "h3" : "h4";
  const Sub = where === "setup" ? "h4" : "h5";
  const locked = busy !== null;
  const anyReady = claudeState === "ready" || chatgptState === "ready";

  const checkAgain = (
    <button type="button" className="os-btn os-btn--ghost" onClick={() => void recheck()} disabled={rechecking}>
      <RefreshCw size={14} aria-hidden="true" /> {rechecking ? "Checking…" : "Check again"}
    </button>
  );
  const note = (words: string) => (
    <p className="os-plan-card__state">
      <StatusMark kind="warn" label="note" /> {words}
    </p>
  );
  const errorLine = (words: string, polite = false) => (
    <p className="os-plan-card__error" role={polite ? "status" : "alert"}>
      <StatusMark kind="error" /> {words}
    </p>
  );

  function renderModels(plan: OpenclawPlan): ReactNode {
    const list = lists[plan];
    if (!list || list.state === "loading" || list.state === "off") return <p className="os-plan-card__hint">Checking…</p>;
    if (list.state === "error") {
      return (
        <>
          {errorLine(list.words)}
          <div className="os-plan-card__row">
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void readList(plan)}>
              <RefreshCw size={14} aria-hidden="true" /> Check again
            </button>
          </div>
        </>
      );
    }
    const value = list.value;
    const fallback = value.source === "fallback";
    const picked = selection[plan];
    const chosen = planApplyModel(value, picked, typed[plan], plan);
    const name = `${baseId}-${plan}-model`;
    return (
      <>
        {list.stale ? (
          <p className="os-plan-card__hint">
            <StatusMark kind="warn" label="note" /> {list.stale}
          </p>
        ) : null}
        {fallback ? (
          <p className="os-plan-card__hint">
            <StatusMark kind="warn" label="note" /> {FALLBACK_LIST_NOTE}
          </p>
        ) : null}
        <fieldset className="os-plan-models">
          <legend className="os-visually-hidden">{PLAN_LABEL[plan]}</legend>
          {value.models.map((entry) => (
            <label key={entry.id} className={`os-plan-model${entry.available ? "" : " os-plan-model--off"}`}>
              <input
                type="radio"
                name={name}
                value={entry.id}
                checked={picked?.kind === "listed" && picked.id === entry.id}
                disabled={!entry.available || locked}
                onChange={() => choose(plan, { kind: "listed", id: entry.id })}
              />
              <span className="os-plan-model__main">
                <strong>{entry.name}</strong>
                {entry.name !== entry.id ? <span className="os-mono os-plan-model__id">{entry.id}</span> : null}
              </span>
              {entry.note ? <span className="os-plan-model__note">{entry.note}</span> : null}
              {entry.available ? null : (
                <span className="os-plan-model__note">
                  <StatusMark kind="warn" label="note" /> {NOT_ON_PLAN_NOTE}
                </span>
              )}
            </label>
          ))}
          {fallback ? (
            <div className="os-plan-model os-plan-model--typed">
              <input
                type="radio"
                name={name}
                value=""
                aria-label={TYPED_MODEL_CHOICE_LABEL}
                checked={picked?.kind === "typed"}
                disabled={locked}
                onChange={() => choose(plan, { kind: "typed" })}
              />
              <span className="os-field os-plan-model__typed">
                <input
                  type="text"
                  value={typed[plan]}
                  placeholder={TYPED_MODEL_LABEL}
                  aria-label={TYPED_MODEL_LABEL}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  disabled={locked}
                  onFocus={() => choose(plan, { kind: "typed" })}
                  onChange={(event) => {
                    const text = event.target.value;
                    setTyped((current) => ({ ...current, [plan]: text }));
                    choose(plan, { kind: "typed" });
                  }}
                />
              </span>
            </div>
          ) : null}
        </fieldset>
        {chosen.problem ? errorLine(chosen.problem, true) : null}
        {errors[plan] ? errorLine(errors[plan] as string) : null}
        <div className="os-plan-card__row">
          <button
            type="button"
            className="os-btn os-btn--primary"
            disabled={!chosen.model || !riskAccepted || locked}
            onClick={() => void apply(plan)}
          >
            {/* The name is what is on the button, then the plan: "Apply · Claude plan", "Starting… · Claude plan". */}
            {busy === plan ? "Starting…" : "Apply"}
            <span className="os-visually-hidden"> · {PLAN_LABEL[plan]}</span>
          </button>
        </div>
      </>
    );
  }

  function claudeBody(state: ClaudePlanState): ReactNode {
    switch (state) {
      case "not_installed":
        return (
          <>
            {note(CLAUDE_PLAN_WORDS.not_installed)}
            <div className="os-plan-card__row">
              <button type="button" className="os-brain-link" onClick={() => navigateTo("setup", { step: "plan" })}>
                Install in Setup
              </button>
            </div>
          </>
        );
      case "not_signed_in":
        return (
          <div className="os-plan-card__row">
            <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("setup", { step: "signin" })}>
              Sign in to Claude Code
            </button>
            {checkAgain}
          </div>
        );
      case "api_billing":
      case "unknown_method":
        return (
          <>
            {note(CLAUDE_PLAN_WORDS[state])}
            <div className="os-plan-card__row">{checkAgain}</div>
          </>
        );
      default:
        return renderModels("claude");
    }
  }

  function chatgptBody(state: ChatgptPlanState): ReactNode {
    const readiness = info?.chatgpt.readiness;
    const readinessWords = readiness === "expiring" ? CHATGPT_PLAN_WORDS.expiring : readiness === "not_ready" ? CHATGPT_PLAN_WORDS.not_ready : null;
    return (
      <>
        {state === "too_old" || state === "version_unknown" ? note(CHATGPT_PLAN_WORDS[state]) : null}
        {state === "no_sharing" ? note(CHATGPT_PLAN_WORDS.no_sharing) : null}
        {state === "ready" && readinessWords ? note(readinessWords) : null}
        {signin ? (
          <PlanSignInTerminal
            key={signin.id}
            sessionId={signin.id}
            autoFocus={signin.fresh}
            onFocused={() =>
              setSignin((current) => (current && current.id === signin.id && current.fresh ? { ...current, fresh: false } : current))
            }
            onEnded={signinOver}
            onClose={(gone) => closedSignIn(signin.id, gone === true)}
          />
        ) : versionBlocked ? (
          <div className="os-plan-card__row">
            <button type="button" className="os-brain-link" onClick={() => navigateTo("setup", { step: "plan" })}>
              Update in Setup
            </button>
          </div>
        ) : state !== "ready" || readinessWords ? (
          <div className="os-plan-card__row">
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void startSignIn()} disabled={locked}>
              {busy === "signin" ? "Starting…" : "Sign in with ChatGPT"}
            </button>
          </div>
        ) : null}
        {/* Not while the version note shows: it says the same sentence the refused Sign in did. */}
        {signinError && !signin && !versionBlocked ? errorLine(signinError) : null}
        {state === "ready" ? renderModels("chatgpt") : null}
      </>
    );
  }

  let body: ReactNode;
  if (job) {
    body =
      job.status === "running" ? (
        <>
          <SetupInstallPanel
            job={job}
            stepLabels={CONFIGURE_STEP_LABEL}
            onCancel={() => void cancelJob()}
            onRetry={backToPlans}
            retryLabel="Back to AI brain"
          />
          {jobError ? errorLine(jobError) : null}
        </>
      ) : (
        <BrainResult
          job={job}
          agents={OPENCLAW_LINE}
          onBack={backToPlans}
          continueLabel="Done"
          // Only once the plans are read: the sign-in terminal lives in the ChatGPT section, which the plans body draws.
          extraAction={
            info && offersSignInAgain(job) ? (
              <button type="button" className="os-btn os-btn--secondary" onClick={() => void signInAgain()} disabled={locked}>
                {busy === "signin" ? "Starting…" : "Sign in again"}
              </button>
            ) : undefined
          }
        />
      );
  } else if (plans.state === "loading") {
    body = <p className="os-plan-card__hint">Checking…</p>;
  } else if (plans.state === "error") {
    body = (
      <>
        {errorLine(plans.words)}
        <div className="os-plan-card__row">{checkAgain}</div>
      </>
    );
  } else {
    body = (
      <>
        {plans.stale ? (
          <p className="os-plan-card__hint">
            <StatusMark kind="warn" label="note" /> {plans.stale}
          </p>
        ) : null}
        {anyReady ? (
          <div className="os-plan-card__consent">
            <p className="os-plan-card__notice">
              <AlertTriangle size={14} aria-hidden="true" /> {OPENCLAW_SECURITY_NOTICE}
            </p>
            <label className="os-brain-risk">
              <input type="checkbox" checked={riskAccepted} disabled={locked} onChange={(event) => setRiskAccepted(event.target.checked)} />
              <span>{OPENCLAW_RISK_LABEL}</span>
            </label>
          </div>
        ) : null}
        {/* The plan OpenClaw is on now is marked for assistive tech only (aria-current); on screen its name and note
            are words on the Brain card's model line, never a colour here. */}
        <div className="os-plan-card__plans">
          <section
            className="os-plan-card__plan"
            data-plan="claude"
            aria-labelledby={`${baseId}-claude`}
            aria-current={currentPlan === "claude" ? "true" : undefined}
          >
            <Sub id={`${baseId}-claude`} className="os-plan-card__plan-title" ref={claudeTitle} tabIndex={-1}>
              {PLAN_LABEL.claude}
            </Sub>
            {claudeState ? claudeBody(claudeState) : null}
          </section>
          <section
            ref={chatgptSection}
            className="os-plan-card__plan"
            data-plan="chatgpt"
            aria-labelledby={`${baseId}-chatgpt`}
            aria-current={currentPlan === "chatgpt" ? "true" : undefined}
          >
            <Sub id={`${baseId}-chatgpt`} className="os-plan-card__plan-title" ref={chatgptTitle} tabIndex={-1}>
              {PLAN_LABEL.chatgpt}
            </Sub>
            {chatgptState ? chatgptBody(chatgptState) : null}
          </section>
        </div>
      </>
    );
  }

  // In Setup it is a card like the other two (they are "os-panel os-brain-card"); on the Agents page it sits inside
  // the Brain panel, so it is no second panel (brain.css gives it a hairline box there).
  return (
    <section
      ref={root}
      className={where === "setup" ? "os-panel os-brain-card os-plan-card" : "os-plan-card"}
      aria-labelledby={`${baseId}-title`}
    >
      <header className="os-plan-card__head">
        <Title id={`${baseId}-title`} ref={cardTitle} tabIndex={-1}>
          Your plan
        </Title>
      </header>
      {body}
    </section>
  );
});

export default BrainPlanCard;
