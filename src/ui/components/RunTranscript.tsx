// Renders one run's folded event groups (see runsShared.ts's groupTranscript)
// as the flight recorder's transcript. Pure presentation: RunConsole owns
// fetching, scrolling and the codex hint; this just draws rows.
import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { RunStreamEvent } from "../../types";
import type { TranscriptGroup } from "../runsShared";
import StatusMark from "./StatusMark";

function FoldRow({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`os-transcript__fold${open ? " os-transcript__fold--open" : ""}`}>
      <button type="button" className="os-transcript__fold-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight size={13} className="os-transcript__chevron" />
        {label}
      </button>
      {open ? <div className="os-transcript__fold-body">{children}</div> : null}
    </div>
  );
}

function ToolRow({ event }: { event: RunStreamEvent }) {
  const [open, setOpen] = useState(false);
  const isResult = event.type === "tool_result";
  const text = String(event.text || "");
  const firstLine = text.split(/\r?\n/)[0] || "";
  return (
    <div className="os-transcript__tool">
      <button
        type="button"
        className="os-transcript__tool-head os-mono"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!isResult || text.length <= firstLine.length}
      >
        {isResult ? <ChevronRight size={12} className="os-transcript__chevron" /> : <span className="os-transcript__tool-dot" aria-hidden="true" />}
        {isResult ? (open ? text : firstLine) : firstLine}
      </button>
    </div>
  );
}

// The closing chips: cost, tokens and duration, each shown only when the run
// really reported it. Cost says why it's missing instead of faking a $0.
function SummaryChips({ events, durationText }: { events: RunStreamEvent[]; durationText: string }) {
  let cost: number | undefined;
  let input: number | undefined;
  let output: number | undefined;
  let isError = false;
  for (const event of events) {
    if (typeof event.costUsd === "number") cost = (cost || 0) + event.costUsd;
    if (typeof event.inputTokens === "number") input = (input || 0) + event.inputTokens;
    if (typeof event.outputTokens === "number") output = (output || 0) + event.outputTokens;
    if ((event.data as { is_error?: boolean } | undefined)?.is_error) isError = true;
  }
  return (
    <div className="os-transcript__chips">
      {isError ? (
        <span className="os-chip os-chip--error">
          <StatusMark kind="error" /> Ended with an error
        </span>
      ) : null}
      <span className="os-chip os-mono" title={cost === undefined ? "this agent doesn't report cost" : undefined}>
        Cost {cost === undefined ? "—" : `$${cost.toFixed(2)}`}
      </span>
      {input !== undefined || output !== undefined ? (
        <span className="os-chip os-mono">
          {(input ?? 0).toLocaleString()} in · {(output ?? 0).toLocaleString()} out
        </span>
      ) : null}
      {durationText && durationText !== "—" ? <span className="os-chip os-mono">Took {durationText}</span> : null}
    </div>
  );
}

export default function RunTranscript({
  groups,
  runStatus,
  durationText = ""
}: {
  groups: TranscriptGroup[];
  runStatus: string;
  durationText?: string;
}) {
  const hasText = groups.some((group) => group.kind === "event" && group.event.type === "text");
  if (groups.length === 0) {
    return <p className="os-transcript__empty">Waiting for output…</p>;
  }
  return (
    <div className="os-transcript">
      {groups.map((group) => {
        if (group.kind === "thinking") {
          return (
            <FoldRow key={group.id} label={`Thinking · ${group.events.length} step${group.events.length === 1 ? "" : "s"}`}>
              {group.events.map((event) => (
                <p key={event.seq} className="os-transcript__thinking-line">
                  {event.text}
                </p>
              ))}
            </FoldRow>
          );
        }
        if (group.kind === "setup") {
          return (
            <FoldRow key={group.id} label={`Setup · ${group.events.length} event${group.events.length === 1 ? "" : "s"}`}>
              {group.events.map((event) => (
                <p key={event.seq} className="os-transcript__setup-line os-mono">
                  {event.text}
                </p>
              ))}
            </FoldRow>
          );
        }
        if (group.kind === "traceback") {
          return (
            <FoldRow key={group.id} label="Stopped by you · technical details">
              {group.events.map((event) => (
                <p key={event.seq} className="os-transcript__setup-line os-mono">
                  {event.text}
                </p>
              ))}
            </FoldRow>
          );
        }
        if (group.kind === "summary") {
          // A result's text usually repeats the last assistant message, so it
          // only shows when the run had no other prose (e.g. Cursor/Hermes).
          const text = hasText ? "" : group.events.map((event) => String(event.text || "").trim()).find(Boolean);
          return (
            <div key={group.id} className="os-transcript__summary">
              {text ? <p className="os-transcript__text">{text}</p> : null}
              <SummaryChips events={group.events} durationText={durationText} />
            </div>
          );
        }

        const event = group.event;
        if (event.type === "text") {
          return (
            <p key={group.id} className="os-transcript__text">
              {event.text}
            </p>
          );
        }
        if (event.type === "tool" || event.type === "tool_result") {
          return <ToolRow key={group.id} event={event} />;
        }
        if (event.type === "system") {
          return (
            // The "Started <command>" line repeats the Flight plan above, so show
            // just "Started" and keep the full text one hover away.
            <p key={group.id} className="os-transcript__system os-mono" title={event.text}>
              {String(event.text || "").startsWith("Started ") ? "Started" : event.text}
            </p>
          );
        }
        if (event.type === "error") {
          return (
            <p key={group.id} className="os-transcript__error">
              <StatusMark kind="error" />
              {event.text}
            </p>
          );
        }
        return (
          <p key={group.id} className="os-transcript__line os-mono">
            {event.text}
          </p>
        );
      })}
    </div>
  );
}
