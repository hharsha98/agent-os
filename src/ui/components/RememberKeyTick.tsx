// "Remember for coding agents": an opt-in tick under a connected OpenRouter
// sign-in. Ticked, Agent OS saves the key (in the Mac's Keychain, or a private
// file elsewhere) so Claude Code and Codex can run on OpenRouter later. Off by
// default: without it the key is forgotten after the Setup step that used it.
// The screen never sees the key: it sends only the sign-in's id (a flow id) and
// reads back whether a key is saved, where, and its last 4 characters.
import { useState } from "react";
import StatusMark from "./StatusMark";
import { useOpenRouterKey } from "./useBuilderBrains";
import { forgetOpenRouterKey, rememberOpenRouterKey } from "../../buildersApi";
import { explain } from "../builderShared";
import "../builders.css";
import "../modelPicker.css";

export function whereKeyIs(backend: "keychain" | "file" | undefined) {
  return backend === "keychain" ? "your Mac's Keychain" : "a private file only you can read";
}

export default function RememberKeyTick({ flowId }: { flowId: string | null }) {
  const { status, reload } = useOpenRouterKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Nothing to offer until we know, and nothing to tick without a connection (or a saved key to forget).
  if (!status || (!status.stored && !flowId)) return null;
  const stored = status.stored;

  async function change(checked: boolean) {
    setBusy(true);
    setError("");
    try {
      if (checked) {
        if (!flowId) return;
        await rememberOpenRouterKey(flowId);
      } else {
        await forgetOpenRouterKey();
      }
      await reload();
    } catch (err) {
      setError(explain(err, "Couldn't change that. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="os-bb-remember">
      <label className="os-bb-remember__tick">
        <input type="checkbox" checked={stored} disabled={busy || (!stored && !flowId)} onChange={(event) => void change(event.target.checked)} />
        <span>Remember for coding agents</span>
      </label>
      {stored ? (
        <p className="os-mp-hint">
          <StatusMark kind="ok" label="saved" />
          <span>
            Saved in {whereKeyIs(status.backend)}
            {status.last4 ? (
              <>
                {" "}· key ends in <span className="os-mono">{status.last4}</span>
              </>
            ) : null}
            . Untick to forget it.
          </span>
        </p>
      ) : (
        <p className="os-mp-hint">
          Off by default. Ticked, Agent OS keeps this key in {whereKeyIs(status.backend)} so Claude Code and Codex can run on OpenRouter. Unticked, it
          is forgotten after this step.
        </p>
      )}
      {error ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> {error}
        </p>
      ) : null}
    </div>
  );
}
