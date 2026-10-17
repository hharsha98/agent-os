// One command on its own line, selectable, with a copy button. If the browser
// blocks copying, nothing breaks: the text is still there to select by hand.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export default function SetupCommand({ command, label = "Copy command" }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access denied; the command is still on screen to select.
    }
  }

  return (
    <div className="os-setup-cmd">
      <code className="os-mono">{command}</code>
      <button type="button" className="os-btn os-btn--ghost os-setup-cmd__copy" onClick={() => void copy()} aria-label={copied ? "Copied" : label}>
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
      <span className="os-visually-hidden" role="status">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
