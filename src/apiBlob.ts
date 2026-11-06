// Files from the app's own API for things that cannot send a header on their own: an <img>, <audio>, <video> or
// <iframe> src, or a download link (R32). Their requests carry the cookie but not the page key, and the server needs
// both. So the page fetches the file with apiFetch (which adds the key) and hands the element an address instead.
//
// A blob: address has the app's own origin and none of the server's headers, so a script inside one (an agent's SVG
// or HTML) could read the page key. Only inert types get a blob: address; an SVG gets a data: address (a data: page
// always has an opaque origin); an HTML preview uses srcDoc in a locked frame; anything else gets no address (R33).
import { useEffect, useState } from "react";
import { apiFetch } from "./sessionKey";

export async function fetchApiBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await apiFetch(url, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.blob();
}

export type PreviewAddressKind = "blob" | "data" | "none";

// Which kind of address a file of this type may be shown from. Decided by the type the server sent (lower-cased, the
// part before any ";"), never by the file's name.
export function previewAddressKind(type: string): PreviewAddressKind {
  const base = String(type || "").split(";")[0].trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"].includes(base)) return "blob";
  if (/^(audio|video)\/.+/.test(base)) return "blob";
  if (base === "image/svg+xml") return "data";
  return "none";
}

// The file as a data: address (what a FileReader gives). Nothing to release afterwards.
function blobToDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read_failed"));
    signal.addEventListener("abort", () => reader.abort(), { once: true });
    reader.readAsDataURL(blob);
  });
}

export type BlobUrlState = { state: "idle" | "loading" | "error"; src: undefined } | { state: "ready"; src: string };

// An address for the file at `url` (null: not wanted, nothing is fetched): blob:, or data: for an SVG, or an error
// for any type that may not have one. A blob: address is released when the address changes or the component goes away.
export function useApiBlobUrl(url: string | null): BlobUrlState {
  const [result, setResult] = useState<BlobUrlState>({ state: url ? "loading" : "idle", src: undefined });

  useEffect(() => {
    if (!url) {
      setResult({ state: "idle", src: undefined });
      return undefined;
    }
    const controller = new AbortController();
    let objectUrl = "";
    const fail = () => {
      if (!controller.signal.aborted) setResult({ state: "error", src: undefined });
    };
    setResult({ state: "loading", src: undefined });
    fetchApiBlob(url, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      const kind = previewAddressKind(blob.type);
      if (kind === "blob") {
        objectUrl = URL.createObjectURL(blob);
        setResult({ state: "ready", src: objectUrl });
      } else if (kind === "data") {
        blobToDataUrl(blob, controller.signal).then((src) => {
          if (!controller.signal.aborted) setResult({ state: "ready", src });
        }, fail);
      } else {
        fail();
      }
    }, fail);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return result;
}

export type TextState = { state: "idle" | "loading" | "error"; text: undefined } | { state: "ready"; text: string };

// The text of the file at `url` (null: not wanted, nothing is fetched). For the locked HTML preview, which draws it
// with srcDoc, so the file never gets an address of its own (R33).
export function useApiText(url: string | null): TextState {
  const [result, setResult] = useState<TextState>({ state: url ? "loading" : "idle", text: undefined });

  useEffect(() => {
    if (!url) {
      setResult({ state: "idle", text: undefined });
      return undefined;
    }
    const controller = new AbortController();
    setResult({ state: "loading", text: undefined });
    fetchApiBlob(url, controller.signal)
      .then((blob) => blob.text())
      .then(
        (text) => {
          if (!controller.signal.aborted) setResult({ state: "ready", text });
        },
        () => {
          if (!controller.signal.aborted) setResult({ state: "error", text: undefined });
        }
      );
    return () => controller.abort();
  }, [url]);

  return result;
}

// Saves the file at `url` under `fileName` (what clicking a plain download link did). The saved copy is re-typed as
// opaque bytes, so an HTML or SVG file can never be drawn as part of the app even if a browser ignores `download` (R33).
export async function saveApiFile(url: string, fileName: string): Promise<void> {
  const blob = await fetchApiBlob(url);
  const objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
