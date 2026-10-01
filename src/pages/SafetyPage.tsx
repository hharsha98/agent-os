// The Safety "arming panel": three level plates (Look only / Run agents /
// Machine control) wired straight to the real execution gate + machine
// control state, plus a read-only agent safeguards list. Every transition
// here is exactly the request the design brief specifies -- no client-side
// guessing of what the server will do, and no level is shown until the
// server has actually told us one.
import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getExecutionGateStatus, updateExecutionGate } from "../api";
import { navigateTo } from "../nav";
import type { ExecutionGateStatus } from "../types";
import SafetyPlate from "../ui/components/SafetyPlate";
import SafetySafeguards from "../ui/components/SafetySafeguards";
import SetupModal from "../ui/components/SetupModal";
import { useInterval } from "../ui/components/useInterval";
import type { AgentDetail, MachineControlStatus } from "../setupApi";
import { friendlyError, getAgentDetail, getMachineControlStatus, setMachineControlStatus } from "../setupApi";
import "../ui/safety.css";

const ARM_PHRASE = "ENABLE MACHINE CONTROL";

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

function levelOf(gate: ExecutionGateStatus, machineControl: MachineControlStatus | null) {
  if (typeof gate.level === "number") return gate.level;
  // Older servers don't send a level; derive it from the two real flags.
  return gate.enabled ? (machineControl?.armed ? 2 : 1) : 0;
}

export default function SafetyPage() {
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [machineControl, setMachineControl] = useState<MachineControlStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hermesDetail, setHermesDetail] = useState<AgentDetail | null>(null);
  const [openclawDetail, setOpenclawDetail] = useState<AgentDetail | null>(null);
  // Distinguishes "still checking" from "checked, but couldn't be read".
  const [safeguardsChecked, setSafeguardsChecked] = useState(false);

  const [showEnableConfirm, setShowEnableConfirm] = useState(false);
  const [enableBusy, setEnableBusy] = useState(false);
  const [enableError, setEnableError] = useState("");
  const [phrase, setPhrase] = useState("");
  const [armBusy, setArmBusy] = useState(false);
  const [armError, setArmError] = useState("");
  const [actionError, setActionError] = useState("");

  async function loadGate() {
    try {
      const [gateRes, mcRes] = await Promise.all([getExecutionGateStatus(), getMachineControlStatus()]);
      setGate(gateRes);
      setMachineControl(mcRes);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }

  async function loadSafeguards() {
    const [hermes, openclaw] = await Promise.all([
      getAgentDetail("hermes").catch(() => null),
      getAgentDetail("openclaw").catch(() => null)
    ]);
    setHermesDetail(hermes);
    setOpenclawDetail(openclaw);
    setSafeguardsChecked(true);
  }

  useEffect(() => {
    void loadGate();
    void loadSafeguards();
  }, []);

  useInterval(() => void loadGate(), 5000);
  useInterval(() => void loadSafeguards(), 20000);

  const known = gate !== null;
  const currentLevel = gate ? levelOf(gate, machineControl) : null;
  const armed = Boolean(machineControl?.armed && machineControl.expiresAt);
  const countdown = useCountdown(armed ? machineControl!.expiresAt : null);
  const expiresLabel = armed ? new Date(machineControl!.expiresAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  // The server disarms on its own at expiry; ask it right away instead of
  // sitting on 00:00 until the next 5-second refresh.
  useEffect(() => {
    if (armed && countdown === "00:00") void loadGate();
  }, [armed, countdown]);

  async function confirmEnable() {
    setEnableBusy(true);
    setEnableError("");
    try {
      const next = await updateExecutionGate({ enabled: true, confirm: true, reason: "Enabled from the Safety page" });
      setGate(next);
      if (!next.enabled) {
        // The server may refuse (locked by its own configuration); say so.
        setEnableError(next.publicSummary || "Agent OS did not turn on Run agents.");
        return;
      }
      setShowEnableConfirm(false);
    } catch (error) {
      setEnableError(friendlyError(error));
    } finally {
      setEnableBusy(false);
    }
  }

  async function turnOffToLookOnly() {
    setActionError("");
    try {
      const next = await updateExecutionGate({ enabled: false });
      setGate(next);
      // Going to level 0 also disarms level 2 on the server; re-read it.
      setMachineControl(await getMachineControlStatus());
      if (next.enabled) setActionError(next.publicSummary || "Agent OS did not turn Run agents off.");
    } catch (error) {
      setActionError(friendlyError(error));
    }
  }

  async function armMachineControl() {
    if (phrase.trim() !== ARM_PHRASE || armBusy) return;
    setArmBusy(true);
    setArmError("");
    try {
      const result = await setMachineControlStatus({ enable: true, phrase, confirm: true });
      setMachineControl(result);
      setPhrase("");
      setGate(await getExecutionGateStatus());
    } catch (error) {
      // The server's own refusal, word for word.
      setArmError(error instanceof Error ? error.message : "Could not arm machine control.");
    } finally {
      setArmBusy(false);
    }
  }

  async function disarmMachineControl() {
    setActionError("");
    try {
      setMachineControl(await setMachineControlStatus({ enable: false }));
      setGate(await getExecutionGateStatus());
    } catch (error) {
      setActionError(friendlyError(error));
    }
  }

  const supported = machineControl?.supported ?? true;

  function level2Extra() {
    if (!known) return null;
    if (!supported) return <p className="os-safety-plate__note">Only available on macOS.</p>;
    if (currentLevel === 2 && armed) {
      return (
        <div className="os-safety-plate__armed">
          <div className="os-safety-plate__armed-clock">
            <span className="os-micro">ARMED · TURNS OFF IN</span>
            <span className="os-mono os-safety-plate__countdown" role="timer" aria-live="off">
              {countdown}
            </span>
            {expiresLabel ? <span className="os-safety-plate__expires">at {expiresLabel}</span> : null}
          </div>
          <button type="button" className="os-btn os-btn--danger os-safety-plate__disarm" onClick={() => void disarmMachineControl()}>
            Disarm now
          </button>
        </div>
      );
    }
    if (currentLevel === 1) {
      return (
        <form
          className="os-safety-plate__arm-form"
          onSubmit={(e) => {
            e.preventDefault();
            void armMachineControl();
          }}
        >
          <label className="os-field">
            <span className="os-field__label">Type {ARM_PHRASE} to arm</span>
            <input
              type="text"
              value={phrase}
              onChange={(e) => {
                setPhrase(e.target.value);
                setArmError("");
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={armError ? true : undefined}
            />
          </label>
          {armError ? (
            <p className="os-setup-brain__error" role="alert">
              <AlertTriangle size={13} /> {armError}
            </p>
          ) : null}
          <button type="submit" className="os-btn os-btn--primary" disabled={phrase.trim() !== ARM_PHRASE || armBusy}>
            {armBusy ? "Arming…" : "Arm"}
          </button>
        </form>
      );
    }
    return <p className="os-safety-plate__note">Turn on &ldquo;Run agents&rdquo; first.</p>;
  }

  if (loadFailed && !known) {
    return (
      <div className="os-safety aos-phase-page">
        <div className="os-fleet__banner">
          <AlertTriangle size={16} />
          <span>Agent OS isn&apos;t responding, so the safety level can&apos;t be shown.</span>
          <button className="os-btn os-btn--secondary" onClick={() => void loadGate()}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="os-safety aos-phase-page">
      <header className="os-safety__header">
        <span className="os-micro">AGENT OS · SAFETY</span>
        <h1>Safety</h1>
      </header>

      {loadFailed ? (
        <div className="os-fleet__banner" role="alert">
          <AlertTriangle size={16} />
          <span>Lost contact with Agent OS. This is the last state it reported.</span>
          <button className="os-btn os-btn--secondary" onClick={() => void loadGate()}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="os-setup__alert" role="alert">
          <AlertTriangle size={16} />
          <span>{actionError}</span>
        </div>
      ) : null}
      {!known ? <p className="os-setup__loading">Checking the current safety level…</p> : null}

      <div className="os-safety__plates">
        <SafetyPlate
          level={0}
          title="Look only"
          active={currentLevel === 0}
          lines={["Agents are detected and previews shown.", "Nothing runs."]}
          action={known && currentLevel !== 0 ? { label: "Switch to Look only", onClick: () => void turnOffToLookOnly() } : null}
        />
        <SafetyPlate
          level={1}
          title="Run agents"
          active={currentLevel === 1}
          lines={[
            "You can launch agents you choose.",
            "Every run shows its command and folder first. Agents work only in the sandbox folder.",
            'Agent OS never passes "skip permissions" flags.'
          ]}
          action={
            known && currentLevel === 0
              ? {
                  label: "Turn on Run agents",
                  onClick: () => {
                    setEnableError("");
                    setShowEnableConfirm(true);
                  }
                }
              : null
          }
        />
        <SafetyPlate
          level={2}
          title="Machine control"
          active={currentLevel === 2}
          activeLabel="Armed"
          accent="warn"
          disabled={known && !supported}
          lines={[
            "Voice, typing, clicking, screen reading and shell commands. macOS only.",
            "Turns itself off after 30 minutes, when Agent OS restarts, or when you go back to level 0.",
            "Each shell command still asks you first."
          ]}
        >
          {level2Extra()}
        </SafetyPlate>
      </div>

      <SafetySafeguards hermes={hermesDetail} openclaw={openclawDetail} checked={safeguardsChecked} onOpenAgent={(agentId) => navigateTo("agents", { agent: agentId })} />

      {showEnableConfirm ? (
        <SetupModal
          title="Turn on Run agents?"
          confirmLabel="Turn on"
          onConfirm={confirmEnable}
          onClose={() => setShowEnableConfirm(false)}
          busy={enableBusy}
          error={enableError}
        >
          <p>Agents you launch will run for real. Every run still shows its command and folder before it starts.</p>
        </SetupModal>
      ) : null}
    </div>
  );
}
