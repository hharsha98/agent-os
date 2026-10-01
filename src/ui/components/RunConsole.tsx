// The flight recorder's run detail: header, flight plan, stop control and
// the live transcript. Reused in `compact` mode as the small inline
// mini-console for a service/safety action (Agents screen), where there is
// no Stop button and no flight-plan disclosure — just "is it still going".
import { useEffect, useRef, useState } from "react";
import { getRun, stopRun, useRunStream } from "../../api";
import { AGENT_MONOGRAM, costLabel, durationLabel, firstLine, runStatusMark } from "../fleetShared";
import { collapseHomePath, friendlyError } from "../agentsShared";
import { codexConfigHint, groupTranscript, statusLabel } from "../runsShared";
import type { RunMeta } from "../../types";
import RelativeTime from "./RelativeTime";
import StatusMark from "./StatusMark";
import RunTranscript from "./RunTranscript";
import AgentConfirmModal from "./AgentConfirmModal";

const ACTIVE_STATUSES = new Set(["queued", "running"]);

export default function RunConsole({
  runId,
  compact = false,
  onEnded
}: {
  runId: string;
  compact?: boolean;
  onEnded?: (status: string) => void;
}) {
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [metaError, setMetaError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopError, setStopError] = useState("");
  const [followBottom, setFollowBottom] = useState(true);
  const { events, status: streamStatus } = useRunStream(runId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endedNotifiedRef = useRef(false);
  // The live mark pulses once per real event, at most once a second: bumping
  // this key remounts the mark, which replays its one-shot CSS pulse.
  const [pulseTick, setPulseTick] = useState(0);
  const lastPulseRef = useRef(0);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  async function refreshMeta() {
    const asked = runId;
    try {
      const next = await getRun(asked);
      // A slow reply for the run we just navigated away from must not
      // overwrite the new run's header.
      if (asked !== runIdRef.current) return;
      setMeta(next);
      setMetaError("");
    } catch (error) {
      if (asked !== runIdRef.current) return;
      setMetaError(friendlyError(error));
    }
  }

  useEffect(() => {
    setMeta(null);
    setMetaError("");
    setStopping(false);
    endedNotifiedRef.current = false;
    void refreshMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Poll while the run is active — the stream carries transcript events, but
  // exitCode/usage/endedAt only ever land on the meta object.
  useEffect(() => {
    if (!meta || !ACTIVE_STATUSES.has(meta.status)) return undefined;
    const id = setInterval(() => void refreshMeta(), 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.status, runId]);

  // The stream's "end" frame is the most honest signal a run is really over;
  // refresh meta the instant it arrives instead of waiting for the next poll.
  useEffect(() => {
    if (streamStatus !== "ended") return;
    void refreshMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamStatus]);

  useEffect(() => {
    if (!meta || ACTIVE_STATUSES.has(meta.status) || endedNotifiedRef.current) return;
    endedNotifiedRef.current = true;
    onEnded?.(meta.status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.status]);

  useEffect(() => {
    if (!events.length) return;
    const now = Date.now();
    if (now - lastPulseRef.current < 1000) return;
    lastPulseRef.current = now;
    setPulseTick((n) => n + 1);
  }, [events.length]);

  useEffect(() => {
    if (!followBottom || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events, followBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollowBottom(atBottom);
  }

  async function handleStopConfirm() {
    setStopError("");
    try {
      setStopping(true);
      await stopRun(runId);
      // "Stopping…" stays up until refreshMeta (polling above) reports a
      // terminal status — never claim "Stopped" before the server says so.
      setStopConfirmOpen(false);
      void refreshMeta();
    } catch (error) {
      setStopError(friendlyError(error));
      setStopping(false);
    }
  }

  if (metaError && !meta) {
    return (
      <div className="os-run-console os-run-console--error">
        <p>{metaError}</p>
        <button type="button" className="os-btn os-btn--secondary" onClick={() => void refreshMeta()}>
          Retry
        </button>
      </div>
    );
  }

  if (!meta) {
    return <div className="os-run-console os-run-console--loading">…</div>;
  }

  const isActive = ACTIVE_STATUSES.has(meta.status);
  const groups = groupTranscript(events, meta.status);
  const showCodexHint = codexConfigHint(meta.agentId, meta.status, events);
  const inputTokens = meta.usage?.inputTokens;
  const outputTokens = meta.usage?.outputTokens;

  return (
    <div className={`os-run-console${compact ? " os-run-console--compact" : ""}`}>
      <header className="os-run-console__header">
        <span className="os-run-console__mono os-mono">{AGENT_MONOGRAM[meta.agentId || ""] || "—"}</span>
        <div className="os-run-console__headtext">
          <strong>{meta.title || firstLine(meta.commandPreview, 60) || "Run"}</strong>
          <span className="os-run-console__meta">
            <StatusMark key={pulseTick} kind={runStatusMark(meta.status)} pulse={isActive && pulseTick > 0} />
            {stopping && isActive ? "Stopping…" : statusLabel(meta.status)}
          </span>
        </div>
        {!compact ? (
          <div className="os-run-console__stats">
            <span className="os-mono">
              {isActive ? <RelativeTime since={meta.startedAt || meta.createdAt} live /> : durationLabel(meta)}
            </span>
            <span className="os-mono" title={typeof meta.exitCode === "number" ? undefined : "not finished yet"}>
              exit {meta.exitCode ?? "—"}
            </span>
            <span className="os-mono" title={typeof meta.usage?.costUsd === "number" ? undefined : "this agent doesn't report cost"}>
              {typeof meta.usage?.costUsd === "number" ? costLabel(meta.usage) : "cost —"}
            </span>
            {typeof inputTokens === "number" || typeof outputTokens === "number" ? (
              <span className="os-mono">
                {inputTokens?.toLocaleString() ?? "—"} in · {outputTokens?.toLocaleString() ?? "—"} out
              </span>
            ) : null}
          </div>
        ) : null}
        {!compact && isActive ? (
          <button type="button" className="os-btn os-btn--danger os-run-console__stop" onClick={() => setStopConfirmOpen(true)} disabled={stopping}>
            Stop
          </button>
        ) : null}
      </header>

      {!compact ? (
        <details className="os-run-console__plan">
          <summary>Flight plan</summary>
          <code className="os-mono">{meta.commandPreview}</code>
          <p className="os-mono os-run-console__plan-folder">{collapseHomePath(meta.cwd)}</p>
        </details>
      ) : null}

      {showCodexHint ? (
        <div className="os-run-console__hint">
          Codex refused its own settings. Check the model in ~/.codex/config.toml, or run <code>codex</code> once in a
          terminal to sign in and pick a supported model.
        </div>
      ) : null}

      <div className={`os-run-console__transcript${compact ? " os-run-console__transcript--compact" : ""}`} ref={scrollRef} onScroll={onScroll}>
        <RunTranscript groups={groups} runStatus={meta.status} durationText={isActive ? "" : durationLabel(meta)} />
      </div>
      {!compact && !followBottom ? (
        <button
          type="button"
          className="os-run-console__jump"
          onClick={() => {
            setFollowBottom(true);
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }}
        >
          Jump to latest
        </button>
      ) : null}

      {stopConfirmOpen ? (
        <AgentConfirmModal
          title="Stop this run?"
          confirmLabel="Stop"
          danger
          busy={stopping}
          onConfirm={handleStopConfirm}
          onClose={() => (stopping ? null : setStopConfirmOpen(false))}
        >
          <p>This sends a stop signal to the agent process. Any partial output stays in the transcript.</p>
          {stopError ? <p className="os-launch__error">{stopError}</p> : null}
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
