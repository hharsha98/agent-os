// How any page puts a short message into the shell's one toast slot at the bottom of the window (Shell.tsx). The shell
// draws one message there at a time, so a page's note and the shell's own messages (the "Hold to stop all" result, a
// browser tab's "needs you" message) never sit on top of each other. No React and no value imports (decision P14), so
// `node --test` loads it straight from src/ (test/sessions-alerts-ui-logic.test.js).

export const SHELL_TOAST_EVENT = "aos-shell-toast";
export type ShellToastTone = "ok" | "warn" | "danger" | "neutral";
export interface ShellToastRequest {
  message: string;
  tone?: ShellToastTone;
}

// The Shell listens for this and shows the message. Plain news ("neutral", "ok") goes after 8 seconds; "warn" and "danger"
// stay until closed (components/Toast.tsx). A message that stays until closed is never replaced by another one: a page's
// note waits (slotMessage) and shows when the one on screen has been closed.
export function showShellToast(message: string, tone: ShellToastTone = "neutral") {
  window.dispatchEvent(new CustomEvent<ShellToastRequest>(SHELL_TOAST_EVENT, { detail: { message, tone } }));
}

// A message that stays until the person closes it (components/Toast.tsx): a warning or a failure.
export function staysUntilClosed(tone: ShellToastTone): boolean {
  return tone === "warn" || tone === "danger";
}

// Which message the shell's one slot shows. `own` is what the shell itself wants shown (the "Hold to stop all" result, else a
// browser tab's "needs you" message), `page` is the latest note a page asked for (showShellToast), either may be null.
// - A message that stays until closed keeps the slot: a page's note waits (it stays pending in the shell) and shows once
//   the sticky one is closed. So a stop-all failure, or a "needs you" message, is never replaced and never missed.
// - A page note that stays until closed itself takes the slot from plain news.
// - Between two plain messages, the newer one (the larger id) shows.
export function slotMessage<T extends { id: number; tone: ShellToastTone }>(own: T | null, page: T | null): T | null {
  if (!own) return page;
  if (!page) return own;
  if (staysUntilClosed(own.tone)) return own;
  if (staysUntilClosed(page.tone)) return page;
  return page.id >= own.id ? page : own;
}
