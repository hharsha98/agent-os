// The page key (R32, browser mode). The login claim hands the page a one-time key; the page keeps it in its OWN
// origin's storage (a page on another local port cannot read it, though it can be sent the cookie) and sends it with
// every request to /api/ in the x-agent-os-key header. The server accepts the cookie only together with this key, so a
// stolen cookie alone gets nothing. Browsers cannot set a header on a WebSocket, so there the key goes as the
// subprotocol "agent-os-key.<key>".
//
// Every call the page makes to its own server goes through apiFetch (or openEventStream, which uses it): this is the
// ONE place that adds the key. It is never put in an address, never logged and never shown on screen.

export const PAGE_KEY_HEADER = "x-agent-os-key";
export const PAGE_KEY_SUBPROTOCOL_PREFIX = "agent-os-key.";
const STORAGE_NAME = "agentos.pageKey";

// Kept in memory too, so a browser that refuses storage still works until the page is reloaded.
let memoryKey = "";

export function readPageKey(): string {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_NAME);
    if (stored) return stored;
  } catch {
    // Storage blocked or unavailable: the in-memory copy is all there is.
  }
  return memoryKey;
}

// Keeps the key the login claim answered with. Anything that is not a non-empty string is ignored.
export function storePageKey(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  memoryKey = key;
  try {
    globalThis.localStorage?.setItem(STORAGE_NAME, key);
  } catch {
    // Storage blocked: the in-memory copy still serves this page.
  }
  return true;
}

export function clearPageKey(): void {
  memoryKey = "";
  try {
    globalThis.localStorage?.removeItem(STORAGE_NAME);
  } catch {
    // Nothing to clear.
  }
}

// Only the app's own API gets the key: a relative "/api/..." address, never another site's.
function isOwnApiAddress(input: string): boolean {
  return typeof input === "string" && input.startsWith("/api/");
}

// fetch() for the app's own API. With a stored key it adds x-agent-os-key (keeping every header the caller set);
// without one, or for any other address, the call is exactly fetch(input, init).
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const key = isOwnApiAddress(input) ? readPageKey() : "";
  if (!key) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set(PAGE_KEY_HEADER, key);
  return fetch(input, { ...init, headers });
}

// The subprotocols a WebSocket to the app's own server offers: the key, or none (then new WebSocket(url) as before).
export function pageKeyProtocols(): string[] | undefined {
  const key = readPageKey();
  return key ? [`${PAGE_KEY_SUBPROTOCOL_PREFIX}${key}`] : undefined;
}

// The login claim, shared by the launch link (main.tsx) and the pasted token (LockedScreen.tsx): sends the token,
// and keeps the page key the server answers with. true when the server accepted the token; a network failure throws.
export async function claimSession(token: string): Promise<boolean> {
  const response = await fetch("/api/session/claim", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  if (!response.ok) return false;
  const body = await response.json().catch(() => null);
  storePageKey(body?.pageKey);
  return true;
}
