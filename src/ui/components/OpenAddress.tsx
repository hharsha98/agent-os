// A link to another website. In a browser tab it is an ordinary link that opens in a new tab. In the desktop app
// (the Tauri window) a click opens the address in the person's own browser through the opener plugin. The window
// itself cannot open a new one, and the plugin only opens the addresses listed in
// desktop/src-tauri/capabilities/default.json (the pages Agent OS links to itself, nothing else). If opening fails,
// for an address outside that list or for any other reason, the link is replaced by the address with a Copy button
// and a plain sentence, so the person is never left with a link that does nothing. That failure belongs to the
// address that failed: a different address (another agent picked) starts again as a plain link. When it happens,
// keyboard focus moves to the Copy button (the link it was on is gone) and the sentence is spoken by a status
// region that is in the page empty first and filled a moment later, which screen readers announce.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { isDesktopApp } from "../desktop";

// Lazy import, like desktop.ts and UpdateBanner: a plain browser tab never loads the Tauri packages.
// The opener is given the address in its written-out form (new URL(href).href), which is the form its
// permission list is written for: a bare origin always ends in "/". Only web addresses are ever handed over.
async function openInBrowser(href: string): Promise<void> {
  const url = new URL(href);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Not a web address.");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url.href);
}

// How long the empty status region sits in the page before its sentence is put in it.
const STATUS_DELAY_MS = 120;
const OPEN_FAILED = "Couldn't open it from here. Copy the address and paste it into your browser.";
const COPY_FAILED = "Couldn't copy it. Select the address and copy it yourself.";

export default function OpenAddress({
  href,
  children,
  className,
  copyLabel = "Copy address",
  buttonClassName = "os-btn os-btn--ghost os-addr__copy",
  showAddress = true
}: {
  href: string;
  // The link's words.
  children: ReactNode;
  className?: string;
  // The Copy button's words, shown in the desktop app when the link could not be opened.
  copyLabel?: string;
  buttonClassName?: string;
  // false when the page already shows the address next to this.
  showAddress?: boolean;
}) {
  // Both are remembered WITH the address they are about, so a new address never inherits an old failure.
  const [failedHref, setFailedHref] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ href: string; ok: boolean } | null>(null);
  const openFailed = failedHref === href;
  const copyState = copied?.href !== href ? "idle" : copied.ok ? "copied" : "failed";
  // The status sentence fills in after the region is already in the page (see the top of this file).
  const [spoken, setSpoken] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!openFailed) {
      setSpoken(false);
      return;
    }
    if (moveFocus.current) {
      moveFocus.current = false;
      copyButton.current?.focus();
    }
    const timer = window.setTimeout(() => setSpoken(true), STATUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [openFailed]);
  if (!isDesktopApp()) {
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  if (!openFailed) {
    return (
      <a
        className={className}
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          // Handled here, so the opener's own click listener (which does not report a refusal) leaves it alone.
          event.preventDefault();
          openInBrowser(href).catch(() => {
            moveFocus.current = true;
            setFailedHref(href);
          });
        }}
      >
        {children}
      </a>
    );
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      setCopied({ href, ok: true });
    } catch {
      setCopied({ href, ok: false });
    }
  }
  return (
    <span className="os-addr">
      {showAddress ? <span className="os-addr__text os-mono">{href}</span> : null}
      <button ref={copyButton} type="button" className={buttonClassName} onClick={() => void copy()}>
        {copyState === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        {copyState === "copied" ? "Address copied" : copyLabel}
      </button>
      <span className="os-addr__fail" role="status">
        {copyState === "failed" ? COPY_FAILED : spoken ? OPEN_FAILED : ""}
      </span>
    </span>
  );
}
