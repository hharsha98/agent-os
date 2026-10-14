// A link to another website. In a browser tab it is an ordinary link that opens in a new tab. In the desktop app
// (the Tauri window) such a link does nothing: the window cannot open a new one, and the opener plugin is only
// allowed to reveal a file in Finder. Rather than a dead link, the desktop app shows the address with a
// "Copy address" button, so the person can paste it into their browser. (Opening it for them would need the
// opener plugin's open-url permission, which the owner has not granted.)
import { useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { isDesktopApp } from "../desktop";

export default function OpenAddress({
  href,
  children,
  className,
  copyLabel = "Copy address",
  buttonClassName = "os-btn os-btn--ghost os-addr__copy",
  showAddress = true
}: {
  href: string;
  // The link's words in a browser tab.
  children: ReactNode;
  className?: string;
  // The button's words in the desktop app.
  copyLabel?: string;
  buttonClassName?: string;
  // false when the page already shows the address next to this.
  showAddress?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  if (!isDesktopApp()) {
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <span className="os-addr">
      {showAddress ? <span className="os-addr__text os-mono">{href}</span> : null}
      <button type="button" className={buttonClassName} onClick={() => void copy()}>
        {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        {state === "copied" ? "Address copied" : copyLabel}
      </button>
      {state === "failed" ? (
        <span className="os-addr__fail" role="status">
          Couldn&apos;t copy it. Select the address and copy it yourself.
        </span>
      ) : null}
    </span>
  );
}
