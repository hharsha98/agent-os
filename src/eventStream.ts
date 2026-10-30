// A text/event-stream reader built on fetch (R32). The browser's EventSource cannot send the x-agent-os-key header
// (and the key must never go in the address), so the run and team-room streams are read with apiFetch instead.
//
// It behaves like the EventSource those two hooks used, in the one way they used it: it opens once, never reconnects
// by itself, and tells the caller when the stream ended without the caller closing it (the hooks then check whether
// the session is still signed in).
import { apiFetch } from "./sessionKey";

export type SseHandler = (eventName: string, data: string) => void;

// Feeds text in pieces and calls `onMessage` for each complete message (a block ended by a blank line) that has data.
// Follows the format's rules: lines end in \n, \r\n or \r; "event:" names the message ("message" when absent);
// several "data:" lines join with \n; a line starting with ":" is a comment; "id:" and "retry:" are not needed here.
export function createSseParser(onMessage: SseHandler) {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  function line(text: string) {
    if (text === "") {
      if (dataLines.length > 0) onMessage(eventName || "message", dataLines.join("\n"));
      eventName = "";
      dataLines = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      // A trailing "\r" may be the first half of "\r\n": wait for the next piece before treating it as a line end.
      const held = buffer.endsWith("\r") ? "\r" : "";
      const lines = buffer.slice(0, buffer.length - held.length).split(/\r\n|\n|\r/);
      buffer = (lines.pop() ?? "") + held;
      for (const text of lines) line(text);
    }
  };
}

export interface EventStreamHandlers {
  // The server answered and the stream is open.
  onOpen: () => void;
  // One message: its event name ("message" for an unnamed one) and its data text.
  onEvent: SseHandler;
  // The server refused, the network failed, or the stream ended while the caller had not closed it. Called once.
  onError: () => void;
}

export interface EventStream {
  close: () => void;
}

export function openEventStream(url: string, handlers: EventStreamHandlers): EventStream {
  const controller = new AbortController();
  let closed = false;

  const fail = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    handlers.onError();
  };

  void (async () => {
    try {
      const response = await apiFetch(url, {
        credentials: "same-origin",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal
      });
      if (closed) return;
      if (!response.ok || !response.body) {
        fail();
        return;
      }
      handlers.onOpen();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser((name, data) => {
        if (!closed) handlers.onEvent(name, data);
      });
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      fail();
    } catch {
      fail();
    }
  })();

  return {
    close() {
      closed = true;
      controller.abort();
    }
  };
}
