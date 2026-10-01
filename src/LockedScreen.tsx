import { useEffect, useRef, useState } from "react";

// shown when the local session cookie is missing or wrong
// (a 401 session_required from any API call fires "agentos:locked"). Lets
// the operator paste the token from the terminal login line instead of
// re-opening the printed link.
export default function LockedScreen() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/session/claim", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });
      if (!response.ok) {
        setError("That token was not accepted.");
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setError("Could not reach Agent OS.");
      setBusy(false);
    }
  }

  return (
    <div className="os-shell os-locked">
      <form className="os-panel os-panel--raised os-locked__card" onSubmit={unlock}>
        <div className="os-locked__brand">
          <div className="os-logo-mark">A</div>
          <span className="os-micro">LOCKED</span>
        </div>
        <h2 className="os-locked__title">Agent OS is locked</h2>
        <p className="os-locked__copy">Open the login link printed in the terminal where you started it.</p>
        <label className="os-field">
          <span className="os-field__label">Login token</span>
          <input
            ref={inputRef}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="os-locked__error">{error}</p> : null}
        <button className="os-btn os-btn--primary os-locked__submit" type="submit" disabled={busy || !token.trim()}>
          Unlock
        </button>
      </form>
    </div>
  );
}
