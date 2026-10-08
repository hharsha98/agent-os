// The hangar's hero panel: prompt in, a dry "flight plan" preview, then a
// confirmed launch. Also owns the three states that replace the form
// entirely — not installed, gate off, and (implicitly) loading — because
// each is really "there is no form to show yet", not a form overlay.
import { useState } from "react";
import type { FormEvent } from "react";
import { previewAgentRun, startAgentRun } from "../../api";
import type { AgentRunOptions } from "../../api";
import type { BuilderBrains } from "../../buildersApi";
import { navigateTo } from "../../nav";
import type { AgentRunPreview, ExecutionGateStatus, RunMeta } from "../../types";
import { ALLOW_EDITS_AGENT_SET, SETUP_INSTALLED_AGENT_SET, collapseHomePath, friendlyError } from "../agentsShared";
import { brainText, isBuilderId } from "../builderShared";
import AgentConfirmModal from "./AgentConfirmModal";
import LaunchBrainOverride from "./LaunchBrainOverride";
import type { BrainOverrideState } from "./LaunchBrainOverride";

export default function AgentLaunchPanel({
  agentId,
  label,
  installed,
  homepage,
  gate,
  gateFailed,
  onReloadGate,
  onRecheck,
  onLaunched,
  brains = null
}: {
  agentId: string;
  label: string;
  installed: boolean;
  homepage: string;
  gate: ExecutionGateStatus | null;
  gateFailed: boolean;
  onReloadGate: () => Promise<void>;
  onRecheck: () => Promise<void>;
  onLaunched: (run: RunMeta) => void;
  // The coding agents' saved brains (for the "Brain for this run" choice).
  brains?: BuilderBrains | null;
}) {
  const [prompt, setPrompt] = useState("");
  const [folder, setFolder] = useState("");
  const [allowEdits, setAllowEdits] = useState(false);
  const [preview, setPreview] = useState<AgentRunPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const [rechecking, setRechecking] = useState(false);
  const [brainState, setBrainState] = useState<BrainOverrideState>({ override: null, problem: "" });

  const canAllowEdits = ALLOW_EDITS_AGENT_SET.has(agentId);
  const trimmedPrompt = prompt.trim();
  const builderId = isBuilderId(agentId) ? agentId : null;
  // What this one run asks for beyond the defaults (nothing at all for most runs).
  const runOptions: AgentRunOptions | undefined =
    canAllowEdits || (builderId && brainState.override)
      ? { ...(canAllowEdits ? { allowEdits } : {}), ...(builderId && brainState.override ? { brain: brainState.override } : {}) }
      : undefined;
  const brainProblem = builderId ? brainState.problem : "";

  async function runPreview(): Promise<AgentRunPreview | null> {
    if (!trimmedPrompt) {
      setPreviewError("Write a prompt first.");
      return null;
    }
    if (brainProblem) {
      setPreviewError(brainProblem);
      return null;
    }
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const result = await previewAgentRun(agentId, {
        prompt,
        folder: folder.trim() || undefined,
        options: runOptions
      });
      setPreview(result);
      return result;
    } catch (error) {
      setPreviewError(friendlyError(error));
      setPreview(null);
      return null;
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handlePreviewSubmit(event: FormEvent) {
    event.preventDefault();
    await runPreview();
  }

  async function handleLaunchClick() {
    if (previewBusy) return;
    // Always re-preview immediately before confirming, so the modal never
    // shows a stale command if the prompt/folder/toggle changed since the
    // last Preview click.
    const fresh = await runPreview();
    if (fresh) setConfirmOpen(true);
  }

  async function handleConfirmLaunch() {
    setLaunchBusy(true);
    setLaunchError("");
    try {
      const run = await startAgentRun(agentId, {
        prompt,
        folder: folder.trim() || undefined,
        options: runOptions
      });
      setConfirmOpen(false);
      onLaunched(run);
    } catch (error) {
      setLaunchError(friendlyError(error));
      // The gate can flip off between the page's last poll and this click;
      // re-read it so the panel shows the locked state, not a stale form.
      if (error instanceof Error && error.message === "execution_gate_off") {
        setConfirmOpen(false);
        void onReloadGate();
      }
    } finally {
      setLaunchBusy(false);
    }
  }

  async function handleRecheck() {
    setRechecking(true);
    try {
      await onRecheck();
    } finally {
      setRechecking(false);
    }
  }

  if (!installed) {
    const setupInstalled = SETUP_INSTALLED_AGENT_SET.has(agentId);
    return (
      <section className="os-panel os-launch os-launch--empty">
        <div className="os-launch__topline" aria-hidden="true" />
        <h2 className="os-launch__title">Launch</h2>
        <p className="os-launch__empty-copy">{label} is not installed.</p>
        {setupInstalled ? (
          <button type="button" className="os-btn os-btn--primary" onClick={() => navigateTo("setup")}>
            Open Setup
          </button>
        ) : (
          <div className="os-launch__empty-actions">
            <a className="os-btn os-btn--secondary" href={homepage} target="_blank" rel="noreferrer">
              Open homepage
            </a>
            <span className="os-launch__empty-hint">Install it, then press Re-check.</span>
            <button type="button" className="os-btn os-btn--ghost" onClick={handleRecheck} disabled={rechecking}>
              {rechecking ? "Checking…" : "Re-check"}
            </button>
          </div>
        )}
      </section>
    );
  }

  if (gate === null) {
    return (
      <section className="os-panel os-launch os-launch--empty">
        <div className="os-launch__topline" aria-hidden="true" />
        <h2 className="os-launch__title">Launch</h2>
        {gateFailed ? (
          <>
            <p className="os-launch__empty-copy">Couldn&apos;t read the safety setting, so launching is paused.</p>
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void onReloadGate()}>
              Retry
            </button>
          </>
        ) : (
          <p className="os-launch__empty-copy">…</p>
        )}
      </section>
    );
  }

  // level 0 is "Look only" even if some older server still reports enabled.
  if (!gate.enabled || gate.level === 0) {
    return (
      <section className="os-panel os-launch os-launch--empty">
        <div className="os-launch__topline" aria-hidden="true" />
        <h2 className="os-launch__title">Launch</h2>
        <p className="os-launch__empty-copy">Safety is set to Look only. Agents can't run until you allow it.</p>
        <button type="button" className="os-btn os-btn--primary" onClick={() => navigateTo("safety")}>
          Open Safety
        </button>
      </section>
    );
  }

  return (
    <section className="os-panel os-launch">
      <div className="os-launch__topline" aria-hidden="true" />
      <h2 className="os-launch__title">Launch</h2>
      <form onSubmit={handlePreviewSubmit} className="os-launch__form">
        <label className="os-field os-launch__prompt">
          <span className="os-field__label">Prompt</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            placeholder={`What should ${label} do?`}
            maxLength={20000}
          />
        </label>
        <label className="os-field os-launch__folder">
          <span className="os-field__label">Folder (optional — default is the sandbox)</span>
          <input
            type="text"
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder="leave blank for the default sandbox folder"
          />
        </label>
        {canAllowEdits ? (
          <label className="os-launch__toggle">
            <input type="checkbox" checked={allowEdits} onChange={(event) => setAllowEdits(event.target.checked)} />
            <span>Allow edits in this folder</span>
          </label>
        ) : null}
        {builderId ? <LaunchBrainOverride agentId={builderId} label={label} brains={brains} onChange={setBrainState} /> : null}
        <div className="os-launch__actions">
          <button type="submit" className="os-btn os-btn--secondary" disabled={previewBusy || !trimmedPrompt || Boolean(brainProblem)}>
            {previewBusy ? "Previewing…" : "Preview"}
          </button>
          <button
            type="button"
            className="os-btn os-btn--primary"
            onClick={handleLaunchClick}
            disabled={launchBusy || !trimmedPrompt || Boolean(brainProblem)}
            aria-busy={previewBusy}
          >
            Launch
          </button>
        </div>
        {previewError ? <p className="os-launch__error">{previewError}</p> : null}
      </form>

      {preview ? (
        <div className="os-flightplan">
          <span className="os-micro">Flight plan</span>
          <code className="os-mono os-flightplan__command">{preview.commandPreview}</code>
          <p className="os-flightplan__folder os-mono">{collapseHomePath(preview.cwd)}</p>
          {builderId && preview.brain ? <p className="os-flightplan__brain">Brain: {brainText(builderId, preview.brain)}</p> : null}
        </div>
      ) : null}

      {confirmOpen ? (
        <AgentConfirmModal
          title={`Launch ${label}?`}
          confirmLabel="Launch"
          busy={launchBusy}
          onConfirm={handleConfirmLaunch}
          onClose={() => (launchBusy ? null : setConfirmOpen(false))}
        >
          <p>This will actually run {label}.</p>
          {builderId && preview?.brain?.mode === "openrouter" ? (
            <p>It runs on OpenRouter ({preview.brain.model}), paid per use from your OpenRouter credit.</p>
          ) : null}
          {builderId && preview?.brain?.mode === "local" ? <p>It runs on a model on this computer ({preview.brain.model}). That is free, but slower.</p> : null}
          {preview ? (
            <div className="os-flightplan os-flightplan--modal">
              <code className="os-mono os-flightplan__command">{preview.commandPreview}</code>
              <p className="os-flightplan__folder os-mono">{collapseHomePath(preview.cwd)}</p>
            </div>
          ) : null}
          {launchError ? <p className="os-launch__error">{launchError}</p> : null}
        </AgentConfirmModal>
      ) : null}
    </section>
  );
}
