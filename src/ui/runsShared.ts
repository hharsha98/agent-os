// Transcript-grouping helpers shared by the Runs screen ("the flight
// recorder") components. Pure functions only, so RunConsole/RunTranscript
// stay simple to read and to test by hand in the browser.
import type { RunStreamEvent } from "../types";

export type TranscriptGroup =
  | { kind: "thinking"; id: string; events: RunStreamEvent[] }
  | { kind: "setup"; id: string; events: RunStreamEvent[] }
  | { kind: "traceback"; id: string; events: RunStreamEvent[] }
  | { kind: "event"; id: string; event: RunStreamEvent }
  | { kind: "summary"; id: string; events: RunStreamEvent[] };

const TRACEBACK_START = "Traceback (most recent call last):";

function isRawLine(event: RunStreamEvent) {
  return event.type === "line" || event.type === "text";
}

// Folds the transcript per the Runs spec: consecutive `thinking` events into
// one row, consecutive `setup` events into one row, a stopped run's trailing
// Python traceback into one row, and every `usage`/`result` event into a
// single trailing "summary chips" group (pulled out of its natural position
// so it always renders last, per "usage / result: summary chips at the
// end"). Everything else passes through untouched, in original order.
export function groupTranscript(events: RunStreamEvent[], runStatus: string): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  const summaryEvents: RunStreamEvent[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i];

    if (event.type === "usage" || event.type === "result") {
      summaryEvents.push(event);
      i += 1;
      continue;
    }

    if (runStatus === "stopped" && isRawLine(event) && String(event.text || "").startsWith(TRACEBACK_START)) {
      const bucket: RunStreamEvent[] = [event];
      let j = i + 1;
      while (j < events.length && isRawLine(events[j])) {
        bucket.push(events[j]);
        j += 1;
      }
      groups.push({ kind: "traceback", id: `traceback-${event.seq}`, events: bucket });
      i = j;
      continue;
    }

    if (event.type === "thinking" || event.type === "setup") {
      const kind = event.type;
      const bucket: RunStreamEvent[] = [event];
      let j = i + 1;
      while (j < events.length && events[j].type === kind) {
        bucket.push(events[j]);
        j += 1;
      }
      groups.push({ kind, id: `${kind}-${event.seq}`, events: bucket } as TranscriptGroup);
      i = j;
      continue;
    }

    groups.push({ kind: "event", id: `event-${event.seq}`, event });
    i += 1;
  }

  if (summaryEvents.length) {
    groups.push({ kind: "summary", id: `summary-${summaryEvents[0].seq}`, events: summaryEvents });
  }

  return groups;
}

// Codex's own "not supported" refusal (e.g. a model/tier the account can't
// use) surfaces as plain text in its output, not a special event type — so
// this is a text scan over the finished transcript, only for the one agent
// and outcome the spec calls out.
export function codexConfigHint(agentId: string | null, status: string, events: RunStreamEvent[]): boolean {
  if (agentId !== "codex" || status !== "failed") return false;
  return events.some((event) => /not supported/i.test(String(event.text || "")));
}

// "timed_out" would otherwise read as "Timed_out" once CSS capitalises it.
export function statusLabel(status: string): string {
  const text = status.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
