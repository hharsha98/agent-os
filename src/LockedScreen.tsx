import { useState } from "react";

// shown when the local session cookie is missing or wrong
// (a 401 session_required from any API call fires "agentos:locked"). Lets
// the operator paste the token from the terminal login line instead of
// re-opening the printed link.
export default function LockedScreen() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
    <div className="aos-phase2-shell">
      <main className="aos-main">
        <form className="aos-panel" onSubmit={unlock}>
          <div className="aos-panel-head">
            <div>
              <span>LOCKED</span>
              <h2>Agent OS is locked</h2>
            </div>
          </div>
          <p>Open the login link printed in the terminal where you started it.</p>
          <label className="aos-field">
            <span>Login token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error ? <p className="aos-global-error">{error}</p> : null}
          <button className="aos-primary" type="submit" disabled={busy || !token.trim()}>Unlock</button>
        </form>
      </main>
    </div>
  );
}
