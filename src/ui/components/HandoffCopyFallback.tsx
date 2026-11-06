// The hand-off's Copy fallback (spec "SP4 Session extras", Hand-off: "the text is shown with a Copy button"; Task X8):
// the reason line when there is one, then the text in a read-only box with a Copy button. The Hand-off section shows
// it for a Send answered "copy" and for a session whose handed text never got typed; Task X10's hand-over button shows
// it too. The reason is the caller's (a refusal's own sentence, or handoffCopyReason in handoffShared.ts). HandoffText
// is the box and its Copy button on their own: the Hand-off section also shows typed text with it.
import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { HANDOFF_TITLE } from "../handoffShared";

// Handed-over text in a read-only box named by the line above it (or by the section's name when there is no such
// line), with a Copy button.
export function HandoffText({ text, labelId }: { text: string; labelId?: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (!alive.current) return;
      setCopied(true);
      window.setTimeout(() => {
        if (alive.current) setCopied(false);
      }, 2000);
    } catch {
      // No clipboard here: select the text, so ⌘C or Ctrl+C copies it.
      box.current?.focus();
      box.current?.select();
    }
  }

  return (
    <div className="os-handoff__box">
      <textarea
        ref={box}
        className="os-handoff__text"
        readOnly
        rows={5}
        value={text}
        aria-labelledby={labelId}
        aria-label={labelId ? undefined : HANDOFF_TITLE}
      />
      <button type="button" className="os-btn os-btn--secondary os-handoff__copy" onClick={() => void copy()}>
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function HandoffCopyFallback({ text, reason }: { text: string; reason: string | null }) {
  const id = useId();
  return (
    <div className="os-handoff__fallback">
      {reason ? (
        <p id={`${id}-why`} className="os-handoff__why" role="status">
          {reason}
        </p>
      ) : null}
      <HandoffText text={text} labelId={reason ? `${id}-why` : undefined} />
    </div>
  );
}
