// Safety: one level control (Look only / Run agents / Machine control), the safeguards that are
// always working, pending approvals (an honest empty state until SP4) and how Hold to stop all
// works. Every transition is exactly the request the design brief specifies -- no client-side
// guessing of what the server will do, and no level is shown until the server has told us one.
//
// What keeps the page honest when Agent OS is slow or gone:
//   - every request has a time limit, so nothing waits for ever;
//   - the newest read wins, and a change makes older reads obsolete, so a slow poll can never put
//     an old level back on screen;
//   - a read that fails keeps the last good answer under a warning, and clears the warning on success;
//   - a change that got NO answer never says "nothing was changed": it may have gone through, so the
//     page says so and reads the real level again;
//   - a gate answer that is not a valid shape is "unknown", never Look only;
//   - a change shows "Changing…" on the control that was pressed until the answer AND the re-check arrive;
//   - nothing is set after the page is gone.
import { useEffect, useRef, useState } from "react";
import { Clock, RefreshCw } from "lucide-react";
import { getExecutionGateStatus, updateExecutionGate } from "../api";
import { navigateTo } from "../nav";
import type { ExecutionGateStatus } from "../types";
import Banner from "../ui/components/Banner";
import PageHeader from "../ui/components/PageHeader";
import SafetyApprovals from "../ui/components/SafetyApprovals";
import SafetyLevels from "../ui/components/SafetyLevels";
import SafetySafeguards from "../ui/components/SafetySafeguards";
import SafetyStopInfo from "../ui/components/SafetyStopInfo";
import SetupModal from "../ui/components/SetupModal";
import { useInterval } from "../ui/components/useInterval";
import { withTimeout } from "../ui/homeShared";
import {
  ARM_PHRASE,
  BUSY_WORD,
  changeProblem,
  levelButtonId,
  levelOf,
  lookOnlyRefusal,
  MACHINE_LAST_KNOWN_TITLE,
  machineLostWords,
  machineOn,
  PAGE_LEDE,
  phraseMatches
} from "../ui/safetyShared";
import { gotNoAnswer, noAnswerWords } from "../ui/setupGroupShared";
import type { AgentDetail, MachineControlStatus } from "../setupApi";
import { friendlyError, getAgentDetail, getMachineControlStatus, setMachineControlStatus } from "../setupApi";
import "../ui/safety.css";

// The gate and machine control are small local reads and writes.
const READ_TIMEOUT_MS = 8000;
const WRITE_TIMEOUT_MS = 10000;
// GET /api/agents/:id runs each agent's own checks (the server gives Hermes' doctor up to 30 s), so
// the page waits as long as the Agents page does for the same answer.
const GUARDS_TIMEOUT_MS = 25000;

// A true countdown: it re-reads the clock every second against the server's
// own expiry timestamp, so it can never drift into a made-up number.
function useCountdown(expiresAt: string | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return "--:--";
  const remainingMs = Math.max(0, Date.parse(expiresAt) - Date.now());
  const totalSeconds = Math.floor(remainingMs / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// The last good answer for one agent, whether the read after it failed (stale), and whether its
// first read has finished at all (checked; a failed one counts).
interface Reading {
  detail: AgentDetail | null;
  stale: boolean;
  checked: boolean;
}
const NOT_READ: Reading = { detail: null, stale: false, checked: false };

// Which control is waiting for Agent OS: the Look only card, the Run agents card (going down from
// Machine control), or the banner's Turn off now button.
type Pending = "look-only" | "run-agents" | "turn-off" | null;

// An answer the rows can be built from. Anything else counts as a failed read, so odd JSON can
// never throw while the page renders.
function usableDetail(value: unknown): value is AgentDetail {
  const detail = value as Partial<AgentDetail> | null;
  return Boolean(detail && typeof detail === "object" && detail.detected && typeof detail.detected === "object" && detail.safety && typeof detail.safety === "object");
}

async function readAgent(id: string): Promise<AgentDetail | null> {
  try {
    const detail = await withTimeout(getAgentDetail(id), GUARDS_TIMEOUT_MS);
    return usableDetail(detail) ? detail : null;
  } catch {
    return null;
  }
}

// What the person reads when a change failed: the server's own refusal, or "no answer, it may have
// gone through" (see changeProblem).
function problemOf(error: unknown): string {
  return changeProblem(gotNoAnswer(error) ? noAnswerWords(error) : null, friendlyError(error, ""));
}

export default function SafetyPage() {
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [machineControl, setMachineControl] = useState<MachineControlStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hermes, setHermes] = useState<Reading>(NOT_READ);
  const [openclaw, setOpenclaw] = useState<Reading>(NOT_READ);

  const [showEnableConfirm, setShowEnableConfirm] = useState(false);
  const [enableBusy, setEnableBusy] = useState(false);
  const [enableError, setEnableError] = useState("");
  const [showArm, setShowArm] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [armBusy, setArmBusy] = useState(false);
  const [armError, setArmError] = useState("");
  const [actionError, setActionError] = useState("");
  // The change that is on its way (the request, then the re-check), so the pressed control can say so.
  const [pending, setPending] = useState<Pending>(null);
  // Which level button should get keyboard focus once a change has settled.
  const [focusLevel, setFocusLevel] = useState<0 | 1 | 2 | null>(null);

  const alive = useRef(true);
  // The newest gate read wins. A change bumps this too, so a read that began before the change can
  // never overwrite what the change just confirmed.
  const gateNewest = useRef(0);
  const gateBusy = useRef(false);
  const guardsBusy = useRef(false);
  // One change at a time from the level buttons and the banner.
  const changing = useRef(false);

  function supersedeReads() {
    gateNewest.current += 1;
    gateBusy.current = false;
  }

  async function loadGate(force = false) {
    if (gateBusy.current && !force) return;
    const mine = ++gateNewest.current;
    gateBusy.current = true;
    try {
      const [gateRes, mcRes] = await Promise.all([
        withTimeout(getExecutionGateStatus(), READ_TIMEOUT_MS),
        withTimeout(getMachineControlStatus(), READ_TIMEOUT_MS)
      ]);
      if (!alive.current || mine !== gateNewest.current) return;
      // An answer that is not a valid shape is not a level: treat it as a failed read, so the page
      // keeps what it last knew (or says it does not know) and never rings Look only.
      if (levelOf(gateRes, mcRes) === null) {
        setLoadFailed(true);
        return;
      }
      setGate(gateRes);
      setMachineControl(mcRes);
      setLoadFailed(false);
    } catch {
      if (!alive.current || mine !== gateNewest.current) return;
      setLoadFailed(true);
    } finally {
      if (mine === gateNewest.current) gateBusy.current = false;
    }
  }

  // Each agent keeps its last good answer when a later read fails (shown under a warning), and its
  // row updates as soon as ITS answer arrives: a slow agent never hides the other one's row.
  async function loadSafeguards() {
    if (guardsBusy.current) return;
    guardsBusy.current = true;
    const apply = (set: (update: (prev: Reading) => Reading) => void, detail: AgentDetail | null) => {
      if (!alive.current) return;
      set((prev) => (detail ? { detail, stale: false, checked: true } : { detail: prev.detail, stale: true, checked: true }));
    };
    try {
      await Promise.all([
        readAgent("hermes").then((detail) => apply(setHermes, detail)),
        readAgent("openclaw").then((detail) => apply(setOpenclaw, detail))
      ]);
    } finally {
      guardsBusy.current = false;
    }
  }

  useEffect(() => {
    alive.current = true;
    void loadGate();
    void loadSafeguards();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInterval(() => void loadGate(), 5000);
  useInterval(() => void loadSafeguards(), 20000);

  // The level is known only when the gate's answer is a valid shape (levelOf gives null otherwise).
  const currentLevel = gate ? levelOf(gate, machineControl) : null;
  const known = currentLevel !== null;
  // Contact was lost after a good answer: what is on screen is the last state Agent OS reported.
  const lost = loadFailed && known;
  const armed = machineOn(currentLevel, machineControl);
  const countdown = useCountdown(armed ? machineControl!.expiresAt : null);
  const expiresLabel = armed ? new Date(machineControl!.expiresAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const supported = machineControl?.supported ?? true;

  // The server disarms on its own at expiry; ask it right away instead of
  // sitting on 00:00 until the next 5-second refresh.
  useEffect(() => {
    if (armed && countdown === "00:00") void loadGate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, countdown]);

  // Machine control came on while the arming dialog was open (for example the answer to Arm was
  // lost, and the re-check found it on): the dialog has nothing left to do.
  useEffect(() => {
    if (showArm && armed) {
      setShowArm(false);
      setPhrase("");
    }
  }, [showArm, armed]);

  // Run agents came on while its dialog was open (for example the answer to Turn on was lost, and the
  // re-check found it on): the dialog has nothing left to do, as with the arming dialog above.
  useEffect(() => {
    if (showEnableConfirm && currentLevel !== null && currentLevel >= 1) {
      setShowEnableConfirm(false);
      setEnableError("");
    }
  }, [showEnableConfirm, currentLevel]);

  // After a change, put keyboard focus on the level the person is now at, so they keep their place
  // (a banner button that disappears would otherwise drop focus to the page).
  useEffect(() => {
    if (focusLevel === null) return;
    document.getElementById(levelButtonId(focusLevel))?.focus();
    setFocusLevel(null);
  }, [focusLevel]);

  async function confirmEnable() {
    setEnableBusy(true);
    setEnableError("");
    try {
      const next = await withTimeout(updateExecutionGate({ enabled: true, confirm: true, reason: "Enabled from the Safety page" }), WRITE_TIMEOUT_MS);
      if (!alive.current) return;
      supersedeReads();
      setGate(next);
      if (!next.enabled) {
        // The server may refuse (locked by its own configuration); say so.
        setEnableError(next.publicSummary || "Agent OS did not turn on Run agents.");
        return;
      }
      setShowEnableConfirm(false);
      setFocusLevel(1);
    } catch (error) {
      if (alive.current) setEnableError(problemOf(error));
    } finally {
      if (alive.current) {
        // Whatever happened, read the real level again, and keep showing "Working…" until it answers.
        await loadGate(true);
        if (alive.current) setEnableBusy(false);
      }
    }
  }

  async function turnOffToLookOnly() {
    if (changing.current) return;
    changing.current = true;
    setPending("look-only");
    setActionError("");
    try {
      const next = await withTimeout(updateExecutionGate({ enabled: false }), WRITE_TIMEOUT_MS);
      if (!alive.current) return;
      supersedeReads();
      setGate(next);
      // Still on after "turn off": when this computer's own settings keep it on, say so in plain words.
      if (next.enabled) setActionError(lookOnlyRefusal(next));
    } catch (error) {
      if (alive.current) setActionError(problemOf(error));
    } finally {
      // Going to level 0 also disarms level 2 on the server; re-read both flags. The pressed card
      // keeps saying "Changing…" until that re-check has answered.
      if (alive.current) {
        await loadGate(true);
        if (alive.current) setPending(null);
      }
      changing.current = false;
    }
  }

  async function armMachineControl() {
    if (!phraseMatches(phrase) || armBusy) return;
    setArmBusy(true);
    setArmError("");
    try {
      const result = await withTimeout(setMachineControlStatus({ enable: true, phrase, confirm: true }), WRITE_TIMEOUT_MS);
      if (!alive.current) return;
      supersedeReads();
      if (!result.armed) {
        setMachineControl(result);
        setArmError("Agent OS answered, but machine control is not on.");
        return;
      }
      setMachineControl(result);
      // The server's answer is the proof; the level is derived from it until the re-read below.
      setGate((g) => (g ? { ...g, level: undefined } : g));
      setPhrase("");
      setShowArm(false);
      setFocusLevel(2);
    } catch (error) {
      // The server's own refusal, word for word; or, with no answer, that it may have gone through.
      if (alive.current) {
        setArmError(
          changeProblem(gotNoAnswer(error) ? noAnswerWords(error) : null, error instanceof Error ? error.message : "Could not arm machine control.")
        );
      }
    } finally {
      if (alive.current) {
        setArmBusy(false);
        void loadGate(true);
      }
    }
  }

  async function disarmMachineControl(from: "run-agents" | "turn-off") {
    if (changing.current) return;
    changing.current = true;
    setPending(from);
    setActionError("");
    try {
      const result = await withTimeout(setMachineControlStatus({ enable: false }), WRITE_TIMEOUT_MS);
      if (!alive.current) return;
      supersedeReads();
      setMachineControl(result);
      setGate((g) => (g ? { ...g, level: undefined } : g));
      setFocusLevel(1);
    } catch (error) {
      if (alive.current) setActionError(problemOf(error));
    } finally {
      if (alive.current) {
        await loadGate(true);
        if (alive.current) setPending(null);
      }
      changing.current = false;
    }
  }

  function pickLevel(n: 0 | 1 | 2) {
    // Nothing is picked while the level is unknown or another change is still on its way.
    if (currentLevel === null || n === currentLevel || pending !== null) return;
    setActionError("");
    if (n === 0) {
      void turnOffToLookOnly();
    } else if (n === 1) {
      if (currentLevel === 2) void disarmMachineControl("run-agents");
      else {
        setEnableError("");
        setShowEnableConfirm(true);
      }
    } else {
      setPhrase("");
      setArmError("");
      if (currentLevel === 0) {
        setActionError("Turn on Run agents (Level 1) first. Machine control builds on it.");
        return;
      }
      setShowArm(true);
    }
  }

  // Only the agents whose re-check failed (and that have a last answer to show) are named.
  const staleAgents = [hermes.stale && hermes.detail ? "Hermes" : null, openclaw.stale && openclaw.detail ? "OpenClaw" : null].filter(
    (name): name is string => name !== null
  );

  return (
    <section className="os-safety" aria-labelledby="os-safety-title">
      {armed ? (
        <Banner
          tone="warn"
          title={lost ? MACHINE_LAST_KNOWN_TITLE : "Machine control is on."}
          actions={
            <button
              type="button"
              className="os-btn os-btn--secondary"
              aria-busy={pending === "turn-off" || undefined}
              onClick={() => void disarmMachineControl("turn-off")}
            >
              {pending === "turn-off" ? BUSY_WORD : "Turn off now"}
            </button>
          }
        >
          {lost ? (
            // No countdown while contact is lost: the page cannot tell whether it is still on.
            machineLostWords(expiresLabel)
          ) : (
            <>
              Agent OS can see the screen and use the mouse and keyboard on this Mac. It turns itself off in <span className="os-mono" role="timer" aria-live="off">{countdown}</span>
              {expiresLabel ? <> at {expiresLabel}</> : null}.
            </>
          )}
        </Banner>
      ) : null}
      {loadFailed ? (
        <Banner
          tone="warn"
          title={known ? "Lost contact with Agent OS" : "Can't reach Agent OS"}
          actions={
            <button
              type="button"
              className="os-btn os-btn--secondary"
              onClick={() => {
                void loadGate(true);
                void loadSafeguards();
              }}
            >
              <RefreshCw size={14} aria-hidden="true" /> Retry
            </button>
          }
        >
          {known
            ? "The level below is the last one it reported. This page tries again every few seconds."
            : "The safety level shows when it answers. This page tries again every few seconds."}
        </Banner>
      ) : null}
      {actionError ? (
        <Banner
          tone="danger"
          actions={<button type="button" className="os-btn os-btn--secondary" onClick={() => setActionError("")}>Dismiss</button>}
        >
          <span className="os-saf-msg">{actionError}</span>
        </Banner>
      ) : null}
      <PageHeader
        titleId="os-safety-title"
        title="Safety"
        lede={PAGE_LEDE}
      />
      <SafetyLevels
        current={currentLevel}
        countdown={countdown}
        supported={supported}
        envLocked={gate?.envLocked === true}
        lastKnown={lost}
        changing={pending === "look-only" ? 0 : pending === "run-agents" ? 1 : null}
        onPick={pickLevel}
      />
      <SafetySafeguards
        hermes={hermes.detail}
        openclaw={openclaw.detail}
        checked={{ hermes: hermes.checked, openclaw: openclaw.checked }}
        staleAgents={staleAgents}
        machine={{ on: armed, countdown, known, lost }}
        onOpenAgent={(agentId) => navigateTo("agents", { agent: agentId })}
      />
      <SafetyApprovals />
      <SafetyStopInfo />

      {showEnableConfirm ? (
        <SetupModal
          title="Turn on Run agents?"
          confirmLabel="Turn on"
          onConfirm={confirmEnable}
          onClose={() => {
            if (!enableBusy) setShowEnableConfirm(false);
          }}
          busy={enableBusy}
          error={enableError}
        >
          <p>Agents you start will run for real, each started in a folder inside the Workspace. Every run shows its command and folder on the Runs page.</p>
        </SetupModal>
      ) : null}

      {showArm ? (
        <SetupModal
          title="Turn on Machine control"
          confirmLabel={armBusy ? "Arming…" : "Arm"}
          confirmDisabled={!phraseMatches(phrase) || armBusy}
          onConfirm={() => void armMachineControl()}
          onClose={() => {
            if (!armBusy) setShowArm(false);
          }}
          busy={armBusy}
          error={armError}
        >
          <p>At Level 2, Agent OS can do more than work in the Workspace:</p>
          <ul className="os-saf-arm-list">
            <li>See your screen.</li>
            <li>Move the mouse and type in other apps on this Mac.</li>
            <li><Clock size={14} aria-hidden="true" /> Turn off by itself after <span className="os-mono">30</span> minutes. To use it again, you type the phrase again.</li>
            <li>Shell commands stay off unless you switch them on separately, and each one still needs your confirmation.</li>
          </ul>
          <label className="os-field">
            <span className="os-field__label">Type {ARM_PHRASE} to turn it on</span>
            <input
              type="text"
              value={phrase}
              onChange={(e) => {
                setPhrase(e.target.value);
                setArmError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && phraseMatches(phrase)) {
                  e.preventDefault();
                  void armMachineControl();
                }
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={armError ? true : undefined}
              aria-describedby="os-saf-arm-hint"
            />
          </label>
          <p id="os-saf-arm-hint" className="os-saf-arm-hint" aria-live="polite">
            {phraseMatches(phrase) ? "The phrase matches. Press Arm." : "The Arm button stays off until the phrase matches."}
          </p>
        </SetupModal>
      ) : null}
    </section>
  );
}
